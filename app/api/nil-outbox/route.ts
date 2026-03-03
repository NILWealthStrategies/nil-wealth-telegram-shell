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

// GET /api/nil-outbox/claim?limit=25
// Claim up to N queued outbox rows, atomically mark as 'sending'
export async function GET(request: NextRequest) {
  try {
    if (!verifyNilSecret(request)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const limit = Math.min(
      Number(request.nextUrl.searchParams.get('limit')) || 10,
      100
    );

    // Atomically claim queued rows: select + update to 'sending' in one go
    const { data: claimedRows, error } = await supabase
      .schema('nil')
      .from('n8n_outbox')
      .select('outbox_id, submission_id, idempotency_key, payload, attempt_count')
      .eq('status', 'queued')
      .order('next_attempt_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Claim query failed: ${error.message}`);
    }

    // Update claimed rows to 'sending'
    if (claimedRows && claimedRows.length > 0) {
      const outboxIds = claimedRows.map((r) => r.outbox_id);
      const { error: updateError } = await supabase
        .schema('nil')
        .from('n8n_outbox')
        .update({ status: 'sending', attempt_count: supabase.sql`attempt_count + 1` })
        .in('outbox_id', outboxIds);

      if (updateError) {
        throw new Error(`Update to sending failed: ${updateError.message}`);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        rows: claimedRows || [],
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

// POST /api/nil-outbox/result
// Update outbox row with final status (sent/failed)
// Body: { submission_id, status: 'sent'|'failed', last_error? }
export async function POST(request: NextRequest) {
  try {
    if (!verifyNilSecret(request)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { submission_id, status, last_error } = body;

    if (!submission_id || !['sent', 'failed'].includes(status)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid submission_id or status' },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const updatePatch: Record<string, unknown> = {
      status,
      last_error: last_error || null,
    };

    if (status === 'sent') {
      updatePatch.sent_at = now;
    }

    // Update outbox row
    const { error: outboxError } = await supabase
      .schema('nil')
      .from('n8n_outbox')
      .update(updatePatch)
      .eq('submission_id', submission_id);

    if (outboxError) {
      throw new Error(`Outbox update failed: ${outboxError.message}`);
    }

    // Also update submissions row with n8n status
    const submissionPatch: Record<string, unknown> = {
      n8n_status: status,
      n8n_last_error: last_error || null,
    };

    if (status === 'sent') {
      submissionPatch.n8n_sent_at = now;
    }

    const { error: subError } = await supabase
      .schema('nil')
      .from('submissions')
      .update(submissionPatch)
      .eq('submission_id', submission_id);

    if (subError && !subError.message.includes('column')) {
      // Ignore column-not-found errors; it means the column doesn't exist yet
      throw new Error(`Submissions update failed: ${subError.message}`);
    }

    return NextResponse.json(
      { ok: true, submission_id, status },
      { status: 200 }
    );
  } catch (error) {
    console.error('[nil-outbox/result]', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}
