"use strict";

const { idShort, roleLabel } = require("./core-utils");
const { tFmtDateTimeShort } = require("./format-utils");

function coverageLabel(payload) {
  const a = payload?.coverage_accident === true;
  const h = payload?.coverage_hospital_indemnity === true;
  if (a && h) return "Accident + Hospital Indemnity";
  if (a) return "Accident";
  if (h) return "Hospital Indemnity";
  return "—";
}

function emailStatusIcon(sent) {
  return sent ? "✅" : "⏳";
}

function smsStatusIcon(sent) {
  return sent ? "✅" : "⏳";
}

function buildSubmissionCard(sub) {
  const p = sub.submission_payload || {};
  const name = `${p.first_name || ""} ${p.last_name || ""}`.trim() || "—";
  const role = sub.your_role || p.your_role || p.role || "parent";
  const intent = sub.intent_answer || p.intent_answer || "—";
  const heard = sub.how_heard_about || p.how_heard_about || "—";
  const emailSent = sub.email_sent === true || sub.enrollment_email_sent === true;
  const smsSent = sub.sms_sent === true || sub.enrollment_sms_sent === true;
  return `🧾 SUBMISSION
--
ID: ${idShort(sub.submission_id)}

Name: ${name}
Email: ${p.email || "—"}
Phone: ${p.phone_e164 || p.phone || "—"}
Athlete: ${p.athlete_name || "—"}
State: ${p.state || "—"}
Role: ${roleLabel(role)}

Intent: ${intent}
How Heard: ${heard}
Coverage: ${coverageLabel(p)}
Referral: ${p.referral_source || p.referral || "—"}

--
Sent Email: ${emailStatusIcon(emailSent)}
Sent SMS: ${smsStatusIcon(smsSent)}

Received: ${tFmtDateTimeShort(sub.created_at)}`;
}

module.exports = {
  coverageLabel,
  emailStatusIcon,
  smsStatusIcon,
  buildSubmissionCard,
};
