def test_smoke_module_imports():
    import db_loc_agent.app  # noqa
    import db_loc_agent.graph  # noqa
    import db_loc_agent.rag  # noqa
    assert True