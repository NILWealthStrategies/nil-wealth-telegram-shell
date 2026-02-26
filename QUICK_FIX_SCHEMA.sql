-- ============================================================================
-- QUICK FIX: Create nil Schema
-- ============================================================================
-- This fixes the "invalid Schema: nil" error in Telegram bot
-- Run this ONE command in Supabase SQL Editor, then test bot again
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS nil;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After running above, verify with:
-- SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'nil';
-- Should return 1 row showing 'nil'
-- ============================================================================

-- THEN test bot in Telegram: /dashboard
-- Should now work without "invalid Schema" error
