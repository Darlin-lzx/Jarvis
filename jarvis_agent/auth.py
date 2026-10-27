"""平台登录鉴权：用户、会话令牌与校验。

- 密码 PBKDF2-SHA256 加盐存储，不落明文
- 会话令牌 12 小时有效，登出即删
- 首次启动无用户时自动播种 admin/admin123
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, String, select

from jarvis_agent.db import Base

SESSION_TTL_HOURS = 12


class AuthUser(Base):
    __tablename__ = "auth_user"

    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False)
    password_hash = Column(String(128), nullable=False)
    salt = Column(String(32), nullable=False)
    display_name = Column(String(64), default="")
    role = Column(String(16), default="user")  # admin / user
    created_at = Column(DateTime, default=datetime.now)


# 登录防爆破：按用户名计失败次数，10 分钟内失败 5 次锁定 5 分钟（进程内状态）
_LOGIN_FAILS: dict[str, list[float]] = {}
_FAIL_WINDOW = 600.0
_FAIL_LIMIT = 5
_LOCK_SECONDS = 300.0


class AuthSession(Base):
    __tablename__ = "auth_session"

    token = Column(String(64), primary_key=True)
    username = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=datetime.now)
    expires_at = Column(DateTime, nullable=False)


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()


def ensure_default_admin(db) -> None:
    """补 role 列（存量库）+ 无任何用户时播种默认管理员 admin/admin123"""
    with db.engine.begin() as conn:
        cols = set()
        try:
            cols = {row[1] for row in conn.exec_driver_sql("SHOW COLUMNS FROM auth_user").fetchall()}
        except Exception:
            try:
                cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(auth_user)").fetchall()}
            except Exception:
                pass
        if "role" not in cols:
            try:
                conn.exec_driver_sql("ALTER TABLE auth_user ADD COLUMN role VARCHAR(16) DEFAULT 'user'")
            except Exception:
                pass
    with db.session() as s:
        admin = s.scalar(select(AuthUser).where(AuthUser.username == "admin"))
        if admin is not None:
            # 存量 admin 可能因补列默认成 user，强制修正为管理员
            if admin.role != "admin":
                admin.role = "admin"
                s.commit()
            return
        if s.scalar(select(AuthUser).limit(1)):
            return
        salt = secrets.token_hex(8)
        s.add(AuthUser(username="admin", salt=salt, role="admin",
                       password_hash=_hash("admin123", salt), display_name="管理员"))
        s.commit()


class LoginLockedError(Exception):
    """连续失败触发锁定（保留语义用）"""


def _prune_expired_sessions(db) -> None:
    """清理过期会话（登录时顺带执行，避免堆积）"""
    with db.session() as s:
        for session in s.scalars(select(AuthSession).where(AuthSession.expires_at < datetime.now())):
            s.delete(session)
        s.commit()


def login(db, username: str, password: str) -> tuple[Optional[str], Optional[str]]:
    """校验用户名密码。成功返回 (token, None)；失败返回 (None, 失败原因)。"""
    import time as _time
    name = (username or "").strip()
    now = _time.time()
    fails = [t for t in _LOGIN_FAILS.get(name, []) if now - t < _FAIL_WINDOW]
    if len(fails) >= _FAIL_LIMIT:
        remain = int(_LOCK_SECONDS - (now - fails[0]))
        return None, f"失败次数过多，账号已锁定，请约 {max(1, remain // 60 + 1)} 分钟后再试"

    _prune_expired_sessions(db)
    with db.session() as s:
        user = s.scalar(select(AuthUser).where(AuthUser.username == name))
        if not user or _hash(password or "", user.salt) != user.password_hash:
            fails.append(now)
            _LOGIN_FAILS[name] = fails[-_FAIL_LIMIT * 2:]
            left = _FAIL_LIMIT - len(fails)
            if left > 0:
                return None, f"用户名或密码错误（再错 {left} 次将锁定账号）"
            return None, "用户名或密码错误，账号已锁定 5 分钟"
        _LOGIN_FAILS.pop(name, None)
        token = secrets.token_hex(32)
        s.add(AuthSession(token=token, username=user.username,
                          expires_at=datetime.now() + timedelta(hours=SESSION_TTL_HOURS)))
        s.commit()
        return token, None


def get_role(db, username: str) -> str:
    with db.session() as s:
        user = s.scalar(select(AuthUser).where(AuthUser.username == username))
        return (user.role if user and user.role else "user") if user else "user"


def change_password(db, username: str, old_password: str, new_password: str) -> tuple[bool, str]:
    """修改自己的密码：校验旧密码 + 新密码至少 8 位"""
    if not new_password or len(new_password) < 8:
        return False, "新密码长度至少 8 位"
    with db.session() as s:
        user = s.scalar(select(AuthUser).where(AuthUser.username == username))
        if not user or _hash(old_password or "", user.salt) != user.password_hash:
            return False, "原密码错误"
        salt = secrets.token_hex(8)
        user.salt = salt
        user.password_hash = _hash(new_password, salt)
        s.commit()
    return True, "密码已修改"


# ---------- 用户管理（仅管理员） ----------

def list_users(db) -> list[dict]:
    with db.session() as s:
        users = list(s.scalars(select(AuthUser).order_by(AuthUser.id)))
        return [{"username": u.username, "display_name": u.display_name or "",
                 "role": u.role or "user",
                 "created_at": u.created_at.isoformat() if u.created_at else None}
                for u in users]


def create_user(db, username: str, password: str, display_name: str, role: str) -> tuple[bool, str]:
    name = (username or "").strip()
    if not name or "'" in name:
        return False, "用户名不能为空且不能含引号"
    if not password or len(password) < 8:
        return False, "初始密码长度至少 8 位"
    if role not in ("admin", "user"):
        role = "user"
    with db.session() as s:
        if s.scalar(select(AuthUser).where(AuthUser.username == name)):
            return False, "用户已存在: " + name
        salt = secrets.token_hex(8)
        s.add(AuthUser(username=name, salt=salt, role=role,
                       password_hash=_hash(password, salt), display_name=display_name or name))
        s.commit()
    return True, "用户 " + name + " 已创建"


def delete_user(db, username: str, operator: str) -> tuple[bool, str]:
    name = (username or "").strip()
    if name == operator:
        return False, "不能删除当前登录账号"
    if name == "admin":
        return False, "不能删除内置管理员"
    with db.session() as s:
        user = s.scalar(select(AuthUser).where(AuthUser.username == name))
        if not user:
            return False, "用户不存在: " + name
        s.delete(user)
        for session in s.scalars(select(AuthSession).where(AuthSession.username == name)):
            s.delete(session)
        s.commit()
    return True, "用户 " + name + " 已删除"


def reset_password(db, username: str, new_password: str) -> tuple[bool, str]:
    if not new_password or len(new_password) < 8:
        return False, "新密码长度至少 8 位"
    with db.session() as s:
        user = s.scalar(select(AuthUser).where(AuthUser.username == (username or "").strip()))
        if not user:
            return False, "用户不存在: " + (username or "")
        salt = secrets.token_hex(8)
        user.salt = salt
        user.password_hash = _hash(new_password, salt)
        s.commit()
    return True, "用户 " + username + " 密码已重置"


def validate(db, token: str) -> Optional[str]:
    """校验令牌，有效返回用户名，无效/过期返回 None"""
    if not token:
        return None
    with db.session() as s:
        session = s.get(AuthSession, token)
        if not session or session.expires_at < datetime.now():
            return None
        return session.username


def display_name_of(db, username: str) -> str:
    with db.session() as s:
        user = s.scalar(select(AuthUser).where(AuthUser.username == username))
        return (user.display_name if user and user.display_name else username) if user else username


def logout(db, token: str) -> None:
    if not token:
        return
    with db.session() as s:
        session = s.get(AuthSession, token)
        if session:
            s.delete(session)
            s.commit()
