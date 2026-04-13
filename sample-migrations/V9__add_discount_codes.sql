-- V4__add_discount_codes.sql
CREATE TABLE IF NOT EXISTS discount_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(50) NOT NULL UNIQUE,
    pct_off     NUMERIC(5,2) NOT NULL CHECK (pct_off > 0 AND pct_off <= 100),
    max_uses    INTEGER NOT NULL DEFAULT 1,
    used_count  INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS discount_code_id UUID REFERENCES discount_codes(id);

CREATE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(code);
CREATE INDEX IF NOT EXISTS idx_orders_discount    ON orders(discount_code_id);
