export interface ApprovalTemplateGuidance {
  alwaysAsk: string[];
  alwaysAllow: string[];
  freeText: string;
}

const PREFIX = '<!-- botharness:approval-guidance:v1 -->\n';

export function parseApprovalTemplateGuidance(
  value: unknown,
): ApprovalTemplateGuidance | undefined {
  if (typeof value !== 'object' || value === null) return;
  if (!('alwaysAsk' in value) || !('alwaysAllow' in value) || !('freeText' in value)) return;
  const { alwaysAsk, alwaysAllow, freeText } = value;
  if (!Array.isArray(alwaysAsk) || !Array.isArray(alwaysAllow) || typeof freeText !== 'string')
    return;
  if (
    !alwaysAsk.every((row: unknown): row is string => typeof row === 'string') ||
    !alwaysAllow.every((row: unknown): row is string => typeof row === 'string')
  )
    return;
  return { alwaysAsk, alwaysAllow, freeText };
}

export function decodeApprovalTemplateGuidance(text: string): ApprovalTemplateGuidance {
  if (!text.startsWith(PREFIX)) return { alwaysAsk: [], alwaysAllow: [], freeText: text };
  const guidance = parseApprovalTemplateGuidance(JSON.parse(text.slice(PREFIX.length)));
  if (guidance === undefined) throw new Error('Invalid approval template guidance');
  return guidance;
}

export function encodeApprovalTemplateGuidance(guidance: ApprovalTemplateGuidance): string {
  return PREFIX + JSON.stringify(guidance) + '\n';
}

export function approvalTemplateReviewerText(text: string): string {
  const guidance = decodeApprovalTemplateGuidance(text);
  return [
    'Always ask (highest priority):',
    JSON.stringify(guidance.alwaysAsk),
    'Always allow (only without a conflict):',
    JSON.stringify(guidance.alwaysAllow),
    'Free text (supplemental; cannot cancel Always ask):',
    guidance.freeText,
  ].join('\n');
}
