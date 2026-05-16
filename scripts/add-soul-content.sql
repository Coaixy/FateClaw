-- 将 soul.md 内容迁移到数据库，消除双写风险
-- Execute: psql $DATABASE_URL < scripts/add-soul-content.sql

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS soul_content TEXT DEFAULT '';
