def test_smoke_module_imports():
    import jarvis_agent.app  # noqa
    import jarvis_agent.graph  # noqa
    import jarvis_agent.rag  # noqa
    assert True