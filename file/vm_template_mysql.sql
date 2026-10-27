-- 工作流模板相关表（本地 MySQL 版，直接建在 jarvis 库）
-- 来源：Oracle 工作流配置库（vm_template / vm_template_version / vm_template_relation）
-- 与「工作流」页导出的 INSERT 语句配套使用：XML 按 4000 字符拆分存入 content..content15
--
-- 使用方式：
--   1. 在 jarvis 库执行本脚本（mysql -u... jarvis < vm_template_mysql.sql）
--   2. 工作流页面切「本地库」开关即直读 jarvis 库（无需注册数据源）

CREATE TABLE IF NOT EXISTS vm_template (
    template_tag    VARCHAR(256)  NOT NULL COMMENT '模板编码',
    template_type   VARCHAR(64)   NULL,
    `label`         VARCHAR(256)  NULL,
    queue_id        VARCHAR(64)   NOT NULL,
    engine_type     VARCHAR(32)   NULL,
    publish         CHAR(1)       NULL,
    create_staff    VARCHAR(64)   NULL,
    create_date     DATETIME      NULL,
    state_date      DATETIME      NULL,
    state           CHAR(1)       NULL,
    remark          VARCHAR(512)  NULL,
    queue_id_alias  VARCHAR(64)   NULL,
    PRIMARY KEY (template_tag)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '工作流模板';

CREATE TABLE IF NOT EXISTS vm_template_version (
    template_version_id DECIMAL(15, 0) NOT NULL COMMENT '版本ID（毫秒时间戳惯例）',
    order_num           DECIMAL(1, 0)  NOT NULL,
    template_tag        VARCHAR(256)   NULL,
    create_staff_id     VARCHAR(64)    NULL,
    create_date         DATETIME       NULL,
    modify_desc         VARCHAR(512)   NULL,
    valid_date          DATETIME       NULL,
    expire_date         DATETIME       NULL,
    `content`           TEXT          NULL COMMENT 'XML 第 1 块（≤4000 字符）',
    content1            TEXT          NULL,
    content2            TEXT          NULL,
    content3            TEXT          NULL,
    content4            TEXT          NULL,
    content5            TEXT          NULL,
    content6            TEXT          NULL,
    content7            TEXT          NULL,
    content8            TEXT          NULL,
    content9            TEXT          NULL,
    content10           TEXT          NULL,
    content11           TEXT          NULL,
    content12           TEXT          NULL,
    content13           TEXT          NULL,
    content14           TEXT          NULL,
    content15           TEXT          NULL,
    PRIMARY KEY (template_version_id),
    KEY idx_vtver_tag (template_tag),
    KEY idx_vtver_valid (valid_date),
    -- 16 个分块列用 TEXT 而非 VARCHAR(4000)：utf8mb4 下 16×4000×4 字节超 MySQL 单行
    -- 65535 字节上限（建表报 1118）；4000 字符上限改由 CHECK 按字符数强制（中文安全）
    CONSTRAINT chk_vtver_content  CHECK (CHAR_LENGTH(`content`)  <= 4000),
    CONSTRAINT chk_vtver_content1 CHECK (CHAR_LENGTH(content1)   <= 4000),
    CONSTRAINT chk_vtver_content2 CHECK (CHAR_LENGTH(content2)   <= 4000),
    CONSTRAINT chk_vtver_content3 CHECK (CHAR_LENGTH(content3)   <= 4000),
    CONSTRAINT chk_vtver_content4 CHECK (CHAR_LENGTH(content4)   <= 4000),
    CONSTRAINT chk_vtver_content5 CHECK (CHAR_LENGTH(content5)   <= 4000),
    CONSTRAINT chk_vtver_content6 CHECK (CHAR_LENGTH(content6)   <= 4000),
    CONSTRAINT chk_vtver_content7 CHECK (CHAR_LENGTH(content7)   <= 4000),
    CONSTRAINT chk_vtver_content8 CHECK (CHAR_LENGTH(content8)   <= 4000),
    CONSTRAINT chk_vtver_content9 CHECK (CHAR_LENGTH(content9)   <= 4000),
    CONSTRAINT chk_vtver_content10 CHECK (CHAR_LENGTH(content10) <= 4000),
    CONSTRAINT chk_vtver_content11 CHECK (CHAR_LENGTH(content11) <= 4000),
    CONSTRAINT chk_vtver_content12 CHECK (CHAR_LENGTH(content12) <= 4000),
    CONSTRAINT chk_vtver_content13 CHECK (CHAR_LENGTH(content13) <= 4000),
    CONSTRAINT chk_vtver_content14 CHECK (CHAR_LENGTH(content14) <= 4000),
    CONSTRAINT chk_vtver_content15 CHECK (CHAR_LENGTH(content15) <= 4000)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '工作流模板版本';

CREATE TABLE IF NOT EXISTS vm_template_relation (
    template_tag   VARCHAR(256) NOT NULL,
    multi_center   VARCHAR(64)  NULL,
    analyze_state  VARCHAR(64)  NULL,
    `version`      VARCHAR(32)  NULL,
    KEY idx_vtrel_tag (template_tag)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '工作流模板关联关系';
