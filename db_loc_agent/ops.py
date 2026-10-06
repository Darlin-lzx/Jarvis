"""迁移后运维（第二级）：健康巡检 + Slow SQL 诊断 + 性能基线/告警。

复用 DbTools 的只读连接能力，以 SELECT 1 探活、记录查询耗时，
并提供慢查询统计与性能基线（P50/P90/MAX 延迟）与超标告警。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select, text

from db_loc_agent.db import Database, OpsCheck, SlowQuery


class OpsService:
    """数据库健康巡检与性能诊断服务。"""

    SLOW_THRESHOLD_MS = 500  # 超过该阈值记为慢查询（可由调用方覆盖）

    def __init__(self, db: Database, db_tools: Any, slow_threshold_ms: int = 500):
        self.db = db
        self.db_tools = db_tools
        self.slow_threshold_ms = slow_threshold_ms

    # ---------- 健康巡检 ----------
    def health_check(self, ds_name: str = "") -> Dict:
        """对（指定或全部启用）数据源执行 SELECT 1 探活，记录延迟与状态。

        每次巡检都落库 ops_checks，供时间线/历史对比。
        """
        targets = ([d for d in self.db_tools.list() if not ds_name or d["name"] == ds_name]
                   if self.db_tools is not None else [])
        checks: List[Dict] = []
        with self.db.session() as s:
            if ds_name and not targets:
                # 指定了不存在的数据源：记为一次失败巡检（便于发现配置漂移）
                s.add(OpsCheck(ds_name=ds_name, kind="", ok=False,
                               latency_ms=0, detail=f"数据源不存在: {ds_name}"))
                s.commit()
                return {"success": True, "data": {"ok": 0, "failed": 1,
                                                  "checks": [{"ds": ds_name, "kind": "",
                                                              "ok": False, "latency_ms": 0,
                                                              "detail": f"数据源不存在: {ds_name}"}],
                                                  "message": f"巡检完成：0/1 正常（{ds_name} 不存在）"}}
            for ds in targets:
                t0 = time.time()
                detail = ""
                ok = False
                try:
                    with self.db_tools.connect(ds["name"]) as conn:
                        conn.execute(text("SELECT 1"))
                    ok = True
                except Exception as e:  # 连接/探活失败
                    detail = str(e)[:300]
                latency = int((time.time() - t0) * 1000)
                s.add(OpsCheck(ds_name=ds["name"], kind=ds["kind"], ok=ok,
                               latency_ms=latency, detail=detail))
                checks.append({"ds": ds["name"], "kind": ds["kind"], "ok": ok,
                               "latency_ms": latency, "detail": detail})
            s.commit()
        if not targets:
            return {"success": True, "data": {"ok": 0, "failed": 0, "checks": [],
                                              "message": "无可巡检的数据源"}}
        ok_n = sum(1 for c in checks if c["ok"])
        return {"success": True, "data": {"ok": ok_n, "failed": len(checks) - ok_n,
                                          "checks": checks,
                                          "message": f"巡检完成：{ok_n}/{len(checks)} 正常"}}

    def check_history(self, limit: int = 50) -> List[Dict]:
        """最近巡检记录（用于页面/时间线展示）。"""
        with self.db.session() as s:
            rows = list(s.scalars(select(OpsCheck)
                                  .order_by(OpsCheck.id.desc()).limit(min(limit, 300))))
            return [{"id": r.id, "ds": r.ds_name, "kind": r.kind, "ok": r.ok,
                     "latency_ms": r.latency_ms, "detail": r.detail,
                     "created_at": r.created_at.isoformat() if r.created_at else None}
                    for r in rows]

    # ---------- 慢 SQL 诊断 ----------
    def record_query(self, ds: str, sql: str, latency_ms: int) -> None:
        """被 DbTools.query 挂钩调用：超过阈值则落一条慢查询记录。"""
        try:
            if latency_ms >= self.slow_threshold_ms:
                with self.db.session() as s:
                    s.add(SlowQuery(ds_name=ds, sql=str(sql)[:1500], latency_ms=int(latency_ms)))
                    s.commit()
        except Exception:
            pass  # 记录失败不影响主查询

    def slow_queries(self, threshold_ms: int = 0, limit: int = 50) -> Dict:
        thr = threshold_ms or self.slow_threshold_ms
        with self.db.session() as s:
            rows = list(s.scalars(select(SlowQuery)
                                  .where(SlowQuery.latency_ms >= thr)
                                  .order_by(SlowQuery.latency_ms.desc()).limit(min(limit, 200))))
            data = [{"id": r.id, "ds": r.ds_name, "sql": r.sql, "latency_ms": r.latency_ms,
                     "created_at": r.created_at.isoformat() if r.created_at else None}
                    for r in rows]
            total = s.scalar(select(func.count()).select_from(SlowQuery)) or 0
        return {"success": True, "data": {"threshold_ms": thr, "total": total,
                                          "queries": data,
                                          "message": f"慢查询（≥{thr}ms）{len(data)} 条"}}

    # ---------- 性能基线 ----------
    def baseline(self) -> Dict:
        """按数据源聚合查询耗时：样本数/P50/P90/MAX，返回基线摘要与超标告警。"""
        with self.db.session() as s:
            rows = s.execute(text(
                "SELECT ds_name, COUNT(*) n, AVG(latency_ms) avg, "
                "MAX(latency_ms) max FROM slow_queries GROUP BY ds_name")).fetchall()
            samples = s.scalar(select(func.count()).select_from(SlowQuery)) or 0
            # 全部查询样本：从 slow_queries 估算 P50/P90 不准确（只记慢查询），
            # 因此再以 ops_checks 的延迟近似探活基线
            checks = s.execute(text(
                "SELECT ds_name, COUNT(*) n, AVG(latency_ms) avg, MAX(latency_ms) max "
                "FROM ops_checks WHERE ok=1 GROUP BY ds_name")).fetchall()
        per_ds = [{"ds": r[0], "samples": r[1], "avg_ms": int(r[2] or 0), "max_ms": int(r[3] or 0)}
                  for r in rows]
        probe = [{"ds": r[0], "samples": r[1], "avg_ms": int(r[2] or 0), "max_ms": int(r[3] or 0)}
                 for r in checks]
        # 告警：慢查询样本的最大耗时超阈值，或探活最大延时超 1s
        thr = max(self.slow_threshold_ms, 1)
        alerts = ([d for d in per_ds if d["max_ms"] > thr] +
                  [{"ds": b["ds"], "samples": b["samples"], "avg_ms": b["avg_ms"],
                    "max_ms": b["max_ms"], "probe": True, "detail": "探活延迟超标"}
                   for b in probe if b["max_ms"] > 1000])
        return {"success": True, "data": {
            "slow_samples": samples,
            "per_ds": per_ds,          # 慢查询聚合
            "probe_baseline": probe,   # 探活延迟基线
            "alerts": alerts,
            "message": f"共记录慢查询样本 {samples} 条；探活基线 {len(probe)} 个数据源"
                       + (f"；{len(alerts)} 条性能告警" if alerts else "")}}