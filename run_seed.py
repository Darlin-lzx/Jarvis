"""入口：把 data/seed 数据导入配置的业务库（MySQL 或 SQLite）。"""
from db_loc_agent.bootstrap import main

if __name__ == "__main__":
    main()
