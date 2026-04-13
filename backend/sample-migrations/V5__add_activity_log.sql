-- V5__add_activity_log.sql
CREATE TABLE IF NOT EXISTS activity_log (
    id          BIGSERIAL PRIMARY KEY,
    entity      VARCHAR(50) NOT NULL,
    entity_id   UUID,
    action      VARCHAR(30) NOT NULL,
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_entity    ON activity_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor     ON activity_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created   ON activity_log(created_at DESC);

-- Convenience view: last 100 events
CREATE OR REPLACE VIEW v_recent_activity AS
    SELECT al.id, al.entity, al.entity_id, al.action,
           u.email AS actor_email, al.detail, al.created_at
    FROM activity_log al
    LEFT JOIN users u ON u.id = al.actor_id
    ORDER BY al.created_at DESC
    LIMIT 100;
