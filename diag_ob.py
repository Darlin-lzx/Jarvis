"""OceanBase 连接一键诊断：分辨 网络不通 / pymysql-OBProxy 通道问题 / 认证失败。

用法（开 VPN 后执行）:
    python diag_ob.py [host] [port] [user] [password]
不带参数时默认诊断「客户订单库」(20.26.208.3:2883 order4@orderb#ywttest)。

说明：OceanBase Oracle 模式租户经 OBProxy 2883 走 MySQL 线协议（与 obclient/
JDBC Connector 同通道），用户名格式 user@tenant#cluster，SQL 为 Oracle 风格。
"""
import socket
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "20.26.208.3"
PORT = int(sys.argv[2] if len(sys.argv) > 2 else 2883)
USER = sys.argv[3] if len(sys.argv) > 3 else "order4@orderb#ywttest"
PWD = sys.argv[4] if len(sys.argv) > 4 else "order4_1Q#"


def step1_tcp():
    print(f"[1/2] TCP 探测 {HOST}:{PORT} ...")
    try:
        s = socket.create_connection((HOST, PORT), timeout=8)
        s.close()
        print("  ✔ 端口可达（网络通，继续第2步）")
        return True
    except OSError as e:
        print(f"  ✘ 端口不可达: {e}")
        print("  → 结论：网络/防火墙问题。检查 VPN 是否连接、分流路由，或换直连端口 2881 再试。")
        return False


def step2_pymysql():
    print("[2/2] pymysql 经 OBProxy 连接（应用同款通道, 含 Oracle 模式能力位, Oracle 风格 SQL）...")
    import pymysql
    try:
        conn = pymysql.connect(host=HOST, port=PORT, user=USER, password=PWD,
                               client_flag=(1 << 27),  # CLIENT_SUPPORT_ORACLE_MODE
                               connect_timeout=10, read_timeout=30, write_timeout=30)
        print("  ✔ 握手成功!")
        with conn.cursor() as cur:
            cur.execute("SELECT table_name FROM user_tables WHERE rownum <= 5")
            tables = [r[0] for r in cur.fetchall()]
            print(f"  ✔ user_tables 可查, 样例: {tables}")
            cur.execute("SELECT 1 FROM dual")
            print(f"  ✔ SELECT FROM dual: {cur.fetchall()}")
        conn.close()
        return True
    except Exception as e:
        print(f"  ✘ {type(e).__name__}: {e}")
        return False


if __name__ == "__main__":
    if not step1_tcp():
        sys.exit(1)
    ok = step2_pymysql()
    print("\n===== 结论 =====")
    if ok:
        print("通道正常 → 应用侧查询功能应可用；若面板仍失败，对比此处参数与数据源配置")
    else:
        print("TCP 通但协议/认证失败 → 把上面的报错发给维护者；常见原因: 租户名/密码错、")
        print("pymysql 初始化语句被 Oracle 模式拒绝、OBProxy 版本协议限制")
