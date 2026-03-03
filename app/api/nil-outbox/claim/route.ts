import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false } }
);

function verifyNilSecret(req: NextRequest): boolean {
  const secret = req.headers.get('x-nil-secret');
  return secret === process.env.NIL_SECRET;
}

export async function GET(request: NextRequest) {
  try {
    if (!verifyNilSecret(request)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 10, 100);

    // Query queued rows where next_attempt_at <= now()
    const now = new Date().toISOString();
    const { data: claimedRows, error } = await supabase
      .schema('nil')
      .from('n8n_outbox')
      .select('outbox_id, submission_id, idempotency_key, payload, attempt_count')
      .eq('status', 'queued')
      .lte('next_attempt_at', now)
      .order('next_attempt_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Claim query failed: ${error.message}`);
    }

    // Atomically update claimed rows to 'sending'
    if (claimedRows && claimedRows.length > 0) {
      const outboxIds = claimedRows.map((r) => r.outbox_id);
      const { error: updateError } = await supabase
        .schema('nil')
        .from('n8n_outbox')
        .update({ 
          status: 'sending',
          attempt_count: supabase.sql`attempt_count + 1`
        })
        .in('outbox_id', outboxIds);

      if (updateError) {
        throw new Error(`Update to sending failed: ${updateError.message}`);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        items: claimedRows || [],
        count: claimedRows?.length || 0,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[nil-outbox/claim]', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}
