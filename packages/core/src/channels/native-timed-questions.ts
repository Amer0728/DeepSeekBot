import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { TimedQuestionPort } from './user-questions.js';
import type { BotRuntime } from '../runtime/bot-runtime.js';
import type { DshSessionStore } from '../sessions/source.js';

const submissionType = 'plugin:botharness/question-answer';
const submissionSchema = z.object({
  callId: z.string(),
  humanId: z.string().nullable(),
  answerHash: z.string(),
});
type Submission = z.infer<typeof submissionSchema>;
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:botharness/question-answer': Submission;
  }
}
const answerHash = (answer: Parameters<TimedQuestionPort['answer']>[2]) =>
  createHash('sha256').update(JSON.stringify(answer.answers)).digest('hex');

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function nativeTimedQuestions(
  ctx: Context,
  runtime: BotRuntime,
  sessions: DshSessionStore,
): TimedQuestionPort {
  const submissions = new Map<string, Submission>();
  const remember = (sessionId: string, events: unknown) => {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      const row = record(event);
      if (row?.['type'] !== submissionType || row['ignorable'] !== true) continue;
      const receipt = submissionSchema.safeParse(row['data']);
      if (receipt.success) submissions.set(sessionId + ':' + receipt.data.callId, receipt.data);
    }
  };
  const views = new Map<string, Record<string, unknown>>();
  const liveRoot = (sessionId: string): unknown => {
    const agents = record(ctx.get('agents'));
    if (typeof agents?.['get'] !== 'function') return undefined;
    const agent: unknown = agents['get'].call(agents, sessionId);
    return record(record(agent)?.['session'])?.['id'] === sessionId ? agent : undefined;
  };
  const questionsOf = (sessionId: string): Record<string, unknown> | undefined => {
    const session = record(liveRoot(sessionId))?.['session'] ?? sessions.get(sessionId);
    if (session === undefined) return views.get(sessionId);
    const service = record(ctx.get('sessionProjections'));
    if (typeof service?.['stateOf'] !== 'function') return undefined;
    const fold: unknown = service['stateOf'].call(service, session, 'userQuestions');
    const questions = record(record(fold)?.['questions']);
    if (questions === undefined) views.delete(sessionId);
    else views.set(sessionId, questions);
    return questions;
  };
  return {
    recordAnswer(sessionId, callId, answer, human) {
      const session = record(liveRoot(sessionId))?.['session'];
      if (!(session instanceof Session)) throw new Error('Native question Session unavailable');
      const receipt = { callId, humanId: human.humanId, answerHash: answerHash(answer) };
      appendPluginRecord(session, submissionType, receipt);
      submissions.set(sessionId + ':' + callId, receipt);
    },
    discardAnswer(sessionId, callId) {
      const session = record(liveRoot(sessionId))?.['session'];
      if (!(session instanceof Session)) throw new Error('Native question Session unavailable');
      const receipt = { callId, humanId: null, answerHash: '' };
      appendPluginRecord(session, submissionType, receipt);
      submissions.set(sessionId + ':' + callId, receipt);
    },
    answeringHuman(sessionId, callId, answer) {
      const session = record(liveRoot(sessionId))?.['session'] ?? sessions.get(sessionId);
      if (session instanceof Session) remember(sessionId, session.snapshotEvents());
      else {
        const stored = sessions.get(sessionId);
        if (stored) remember(sessionId, stored.snapshotEvents());
      }
      const receipt = submissions.get(sessionId + ':' + callId);
      return receipt?.humanId && receipt.answerHash === answerHash(answer)
        ? { humanId: receipt.humanId }
        : undefined;
    },
    bind: (sessionId, channelId, question) =>
      runtime.bindNativeQuestionInput?.(sessionId, channelId, question),
    recover: (sessionId, channelId, requestMessageId) =>
      runtime.recoverNativeQuestionInput?.(sessionId, channelId, requestMessageId),
    available: (sessionId, channelId) =>
      runtime.nativeQuestionAvailable?.(sessionId, channelId) ?? true,
    async load(sessionIds) {
      const query = record(ctx.get('sessionQuery'));
      const projections = record(ctx.get('sessionProjections'));
      if (
        typeof query?.['readSession'] !== 'function' ||
        typeof projections?.['restore'] !== 'function'
      )
        return;
      for (const sessionId of sessionIds) {
        if (liveRoot(sessionId) !== undefined || sessions.get(sessionId) !== undefined) continue;
        try {
          const snapshot = record(await query['readSession'].call(query, sessionId));
          remember(sessionId, snapshot?.['events']);
          const restored: unknown = projections['restore'].call(
            projections,
            {},
            snapshot?.['events'],
            0,
            snapshot?.['session'],
            snapshot?.['inheritedEventCount'] ?? 0,
          );
          const questions = record(
            record(record(record(restored)?.['snapshot'])?.['values'])?.['userQuestions'],
          );
          if (questions !== undefined) views.set(sessionId, questions);
        } catch {
          ctx.logger.warn(`botharness.channel_question.native_read_failed session=${sessionId}`);
        }
      }
    },
    read(sessionId, callId) {
      const questions = questionsOf(sessionId);
      const active = questions?.['active'];
      if (!Array.isArray(active)) return undefined;
      const pending = record(active.find((item: unknown) => record(item)?.['callId'] === callId));
      const state = pending?.['state'];
      if (state === 'open' || state === 'continued') return { state };
      const settled = questions?.['settled'];
      if (!Array.isArray(settled)) return undefined;
      const answers = record(
        settled.find((item: unknown) => record(item)?.['callId'] === callId),
      )?.['answers'];
      if (!Array.isArray(answers)) return undefined;
      return { state: 'answered', answer: { answers } };
    },
    answer(sessionId, callId, answer) {
      const service = record(ctx.get('userQuestions'));
      const agent = liveRoot(sessionId);
      if (typeof service?.['answer'] !== 'function' || agent === undefined) return false;
      return service['answer'].call(service, agent, callId, answer) === true;
    },
  };
}
