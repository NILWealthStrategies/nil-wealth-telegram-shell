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
    const outboxUpdate: Record<string, unknown> = {
      status,
      last_error: last_error || null,
    };

    if (status === 'sent') {
      outboxUpdate.sent_at = now;
    }

    // Update outbox row
    const { error: outboxError } = await supabase
      .schema('nil')
      .from('n8n_outbox')
      .update(outboxUpdate)
      .eq('submission_id', submission_id);

    if (outboxError) {
      throw new Error(`Outbox update failed: ${outboxError.message}`);
    }

    // Update submissions row with n8n status
    const submissionUpdate: Record<string, unknown> = {
      n8n_status: status,
      n8n_last_error: last_error || null,
    };

    if (status === 'sent') {
      submissionUpdate.n8n_sent_at = now;
    }

    const { error: subError } = await supabase
      .schema('nil')
      .from('submissions')
      .update(submissionUpdate)
      .eq('submission_id', submission_id);

    if (subError && !subError.message.includes('column')) {
      // Ignore column-not-found errors (means column doesn't exist yet)
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
