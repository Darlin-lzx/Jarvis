"""DbTools 数据源更新：密码留空应保留原值（编辑表单不回显密码）"""
import pytest
from sqlalchemy import select

from jarvis_agent.db import Database, DataSource
from jarvis_agent.db_tools import DbTools


@pytest.fixture
def tools(tmp_path):
    db = Database(str(tmp_path / "db_tools.db"))
    return db, DbTools(db)


def _row(db, name):
    with db.session() as session:
        return session.scalar(select(DataSource).where(DataSource.name == name))


def test_update_with_blank_password_keeps_stored_password(tools):
    db, db_tools = tools
    db_tools.create("demo", kind="postgresql", location="10.0.0.1:6432/ordercb",
                    username="aiorder", password="secret_1Q#", enabled=True)

    db_tools.update("demo", "demo", "postgresql", "10.0.0.1:6432/ordercb2",
                    "aiorder2", "", "", True)

    row = _row(db, "demo")
    assert row.location == "10.0.0.1:6432/ordercb2"
    assert row.username == "aiorder2"
    from jarvis_agent.db_tools import decrypt_password
    assert decrypt_password(row.password) == "secret_1Q#"  # 留空不覆盖（存储为密文）


def test_update_with_explicit_password_replaces(tools):
    db, db_tools = tools
    db_tools.create("demo", kind="postgresql", location="h:5432/db",
                    username="u", password="old", enabled=True)

    db_tools.update("demo", "demo", "postgresql", "h:5432/db", "u", "new", "", True)

    assert _row(db, "demo").password == "new"


def test_oceanbase_uses_dedicated_obproxy_channel(tools):
    _, db_tools = tools
    assert "oceanbase" in DbTools.DIALECTS
    # OceanBase Oracle 模式租户不再借道 oracledb：走 _ob_connect 专用通道（pymysql/OBProxy）
    with pytest.raises(ValueError, match="_ob_connect"):
        db_tools._conn_str(
            {"kind": "oceanbase", "location": "20.26.208.3:2883/order4",
             "username": "order4@orderb#ywttest", "password": "pw"}, ds_name="客户订单库")


def test_oceanbase_connect_params_and_timeouts(tools, monkeypatch):
    import pymysql
    captured = {}

    class FakeConn:
        def close(self):
            captured["closed"] = True

    def fake_connect(**kwargs):
        captured.update(kwargs)
        return FakeConn()

    monkeypatch.setattr(pymysql, "connect", fake_connect)
    _, db_tools = tools
    with db_tools._ob_connect(
            {"kind": "oceanbase", "location": "20.26.208.3:2883/order4",
             "username": "order4@orderb#ywttest", "password": "pw"}, "客户订单库"):
        pass
    assert captured["host"] == "20.26.208.3"
    assert captured["port"] == 2883
    assert captured["user"] == "order4@orderb#ywttest"
    # 必须声明 OB Oracle 模式握手能力位，否则 OBProxy 报 1235 拒绝
    assert captured["client_flag"] == DbTools.OB_SUPPORT_ORACLE_MODE_FLAG == (1 << 27)
    # 建连与读写超时必须下发，防 VPN 网关代答后的协议黑洞挂死
    assert captured["connect_timeout"] == DbTools.OB_CONNECT_TIMEOUT
    assert captured["read_timeout"] == DbTools.OB_IO_TIMEOUT
    assert captured["write_timeout"] == DbTools.OB_IO_TIMEOUT
    assert captured["closed"] is True


def test_list_masks_password_and_connect_decrypts(tools, monkeypatch):
    db, db_tools = tools
    db_tools.create("demo", kind="postgresql", location="h:5432/db",
                    username="u", password="secret", enabled=True)
    # 列表接口脱敏：不回传密码
    row = next(item for item in db_tools.list() if item["name"] == "demo")
    assert row["password"] == ""
    # 库里是加密存储（enc: 前缀），连接时解密还原
    stored = _row(db, "demo").password
    assert stored.startswith("enc:")
    import jarvis_agent.db_tools as mod
    monkeypatch.setattr(mod, "_ds_fernet", mod._ds_fernet)
    assert mod.decrypt_password(stored) == "secret"


def test_pg_version_parsing_tolerates_goldendb():
    """GoldenDB（PG 协议）version() 两种形态均需解析成功：
    'postgres (PostgreSQL) 13.21 ...' 与无 PG 字样的 'GoldenDB DBV6.0.01.01 on ...'。
    SQLAlchemy 官方正则遇 ')' 或缺失 PG 字样直接断连；db_tools 补丁宽松兜底。"""
    from sqlalchemy.dialects.postgresql import psycopg2 as pg_psycopg2

    class FakeConnection:
        def __init__(self, version):
            self._version = version

        def exec_driver_sql(self, _sql):
            return self

        def scalar(self):
            return self._version

    dialect = pg_psycopg2.PGDialect_psycopg2()
    golden = dialect._get_server_version_info(
        FakeConnection("postgres (PostgreSQL) 13.21 GoldenDB DBV6.0.01.01"))
    assert golden == (13, 21)

    # 无 PG 字样的原始串：取第一段点分版本号
    raw = dialect._get_server_version_info(
        FakeConnection("GoldenDB DBV6.0.01.01 on x86_64-pc-linux-gnu, "
                       "compiled by gcc (GCC) 7.3.0, 64-bit"))
    assert raw == (6, 0, 1)

    standard = dialect._get_server_version_info(
        FakeConnection("PostgreSQL 14.9 (Debian 14.9-1.pgdg120+1)"))
    assert standard[:2] == (14, 9)
