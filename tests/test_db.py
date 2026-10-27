from sqlalchemy import select

from jarvis_agent.db import ArtifactRecord, Conversation, Database, Prompt


def test_create_db_tables_and_crud(tmp_path):
    db = Database(str(tmp_path / "t.db"))
    with db.session() as s:
        c = Conversation(title="会话1")
        s.add(c)
        s.commit()
        s.refresh(c)
        assert c.id is not None
        p = Prompt(name="p1", category="agent", content="hello")
        s.add(p)
        s.commit()
        assert len(list(s.scalars(select(Prompt)))) == 1
        assert len(list(s.scalars(select(ArtifactRecord)))) == 0


def test_db_idempotent(tmp_path):
    path = str(tmp_path / "t.db")
    Database(path)
    Database(path)  # 第二次建表不报错