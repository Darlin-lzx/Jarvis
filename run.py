"""启动入口：uvicorn 由本脚本拉起"""
import uvicorn

from db_loc_agent.app import create_app


def main():
    app = create_app()
    import db_loc_agent.config as cfg_mod
    cfg = cfg_mod.load_config()
    uvicorn.run(app, host=cfg.host, port=cfg.port)


if __name__ == "__main__":
    main()