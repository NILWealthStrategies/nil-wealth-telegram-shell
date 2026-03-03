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
    const limit = Math.min(Number(searchParams.get('limit')) || 25, 50);

    // Use atomic RPC function to claim rows
    // This function does SELECT FOR UPDATE SKIP LOCKED + UPDATE in a single transaction
    const { data: claimedRows, error } = await supabase.rpc('claim_n8n_outbox', {
      limit_count: limit
    });

    if (error) {
      throw new Error(`Claim RPC failed: ${error.message}`);
    }

    return NextResponse.json(
      {
        ok: true,
        items: claimedRows || []
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
