import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false } }
);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields
    const { 
      first_name, 
      last_name, 
      email, 
      phone, 
      state, 
      role,
      intent,
      coverage_accident,
      coverage_hospital_indemnity
    } = body;

    if (!first_name || !last_name || !email || !phone || !state || !role) {
      return NextResponse.json(
        { ok: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Generate or use provided idempotency_key
    const idempotency_key = body.idempotency_key || randomUUID();

    // Generate deterministic submission_id from idempotency_key
    const idemClean = idempotency_key.replace(/-/g, '');
    const submission_id = `NWS-${idempotency_key.slice(0, 8).toUpperCase()}-${idemClean.slice(8, 13).toUpperCase()}`;

    // Build envelope payload
    const trace_id = randomUUID();
    const envelope = {
      event_type: 'submission.created',
      source: 'website',
      direction: 'inbound',
      schema_version: '5.2',
      trace_id,
      idempotency_key,
      entity_type: 'submission',
      entity_id: submission_id,
      client: {
        first_name,
        last_name,
        email,
        phone,
        state,
        role,
        intent: intent || 'coverage_interest'
      },
      payload: {
        coverage_accident: coverage_accident === true,
        coverage_hospital_indemnity: coverage_hospital_indemnity === true
      }
    };

    // Write to nil.submissions
    const { error: subError } = await supabase
      .schema('nil')
      .from('submissions')
      .upsert({
        submission_id,
        idempotency_key,
        first_name,
        last_name,
        email,
        phone,
        state,
        role,
        intent: intent || 'coverage_interest',
        coverage_accident: coverage_accident === true,
        coverage_hospital_indemnity: coverage_hospital_indemnity === true,
        n8n_status: 'queued',
        created_at: new Date().toISOString()
      }, {
        onConflict: 'submission_id'
      });

    if (subError) {
      console.error('[submissions] Supabase submissions error:', subError);
      throw new Error(`Failed to write submission: ${subError.message}`);
    }

    // Write to nil.n8n_outbox
    const { error: outboxError } = await supabase
      .schema('nil')
      .from('n8n_outbox')
      .upsert({
        submission_id,
        idempotency_key,
        payload: envelope,
        status: 'queued',
        next_attempt_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      }, {
        onConflict: 'submission_id',
        ignoreDuplicates: false
      });

    if (outboxError) {
      console.error('[submissions] Supabase outbox error:', outboxError);
      throw new Error(`Failed to write outbox: ${outboxError.message}`);
    }

    // Return immediately with queued status
    return NextResponse.json({
      ok: true,
      queued: true,
      submission_id,
      idempotency_key
    }, { status: 200 });

  } catch (error) {
    console.error('[submissions API]', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
