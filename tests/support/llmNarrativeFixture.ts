/**
 * ETBZ-25B test support — a provider answer that PASSES every gate, and the
 * fake transport that serves it.
 *
 * Why a hand-written answer rather than a recorded one: every negative test in
 * this slice works by taking a VALID answer and changing exactly one thing. If
 * the baseline were a recording, a change in a provider's mood would silently
 * change what each negative test is actually testing. This answer is fixed, is
 * written against the known-time fixture chart, and is asserted to pass both
 * gates in `tests/unit/llm-narrative-fixture.test.ts` — so if a guard ever
 * becomes stricter, the baseline fails loudly instead of the negatives quietly
 * passing for the wrong reason.
 *
 * The prose below is deliberately written the way the prompt asks a real model
 * to write: it names only chart terms its own section cites, it puts the
 * correct role word beside each symbol, it contains no digit, it relates
 * several signals with an explicit connective, and it makes no prohibited
 * claim. It is what "good output" means mechanically in this slice.
 *
 * No real person's data is involved: the chart is the same synthetic fixture
 * ETBZ-24 / ETBZ-29 / ETBZ-25A already use.
 */

import type { Transport } from '../../src/adapters/llm/openai-compatible-client.js';

/** A section of the fixture answer, in the provider's own wire shape. */
export interface FixtureSection {
  themeId: string;
  citedFacts: { factId: string; value: string }[];
  prose: string;
  uncertaintyNotes: string[];
}

export interface FixtureAnswer {
  sections: FixtureSection[];
}

/**
 * The answer for the KNOWN-TIME chart.
 *
 * Nothing in this chart is provisional, so no section carries an uncertainty
 * note; the unknown-time answer below is the one that exercises that path.
 */
export function validKnownTimeAnswer(): FixtureAnswer {
  return {
    sections: [
      {
        themeId: 'primary.self_role',
        citedFacts: [
          { factId: 'chart.dayMaster.stem', value: 'Xin' },
          { factId: 'chart.dayMaster.element', value: 'Metall' },
          { factId: 'chart.dayMaster.polarity', value: 'yin' },
          { factId: 'chart.natal.pillar.year.tenGod', value: 'RobWealth' },
          { factId: 'chart.natal.pillar.month.tenGod', value: 'HurtingOfficer' },
        ],
        prose:
          'Der Tagesmeister Xin steht im Element Metall, und seine Polarität yin gibt diesem Element eine feine, eher zurückhaltende Note. Im Zusammenspiel mit dem Ten God Rivale entsteht ein Muster, in dem Abgrenzung und Zugehörigkeit immer wieder neu ausgehandelt werden: Du misst dich an anderen, ohne das laut zu sagen. Gleichzeitig bringt der Ten God Disruptive Ausgabe einen Drang mit, Dinge anders zu machen, als sie vorgegeben sind. Das erzeugt Reibung, und genau darin liegt auch deine Beweglichkeit. Wo hörst du auf, dich zu vergleichen, und fängst an, zu gestalten?',
        uncertaintyNotes: [],
      },
      {
        themeId: 'primary.seasonal_anchor',
        citedFacts: [
          { factId: 'chart.natal.monthCommand.branch', value: 'Wu' },
          { factId: 'chart.natal.monthCommand.principalQiStem', value: 'Ding' },
          { factId: 'chart.pillar.month.tier', value: 'Pferd' },
        ],
        prose:
          'Dein Monatskommando ruht auf dem Erdzweig Wu; ihm ist das Tierzeichen Pferd zugeordnet. Der darin führende Himmelsstamm Ding färbt die Jahreszeit, in die du hineingeboren bist, ohne sie festzulegen. Zusammen mit dem Erdzweig Wu ergibt das einen Grundton von Aufbruch und sichtbarer Bewegung: Du startest gern, und du startest deutlich. Die Kehrseite zeigt sich dort, wo der Anfang dir leichter fällt als das lange Bleiben. Was in deinem Leben verdient gerade eher Geduld als einen neuen Start?',
        uncertaintyNotes: [],
      },
      {
        themeId: 'primary.elemental_profile',
        citedFacts: [
          { factId: 'chart.wuxing.dominant', value: 'Feuer' },
          { factId: 'chart.wuxing.weight.Feuer', value: '2.5' },
          { factId: 'chart.wuxing.weight.Holz', value: '1.8' },
          { factId: 'chart.wuxing.weight.Metall', value: '2' },
          { factId: 'chart.dayMaster.element', value: 'Metall' },
          { factId: 'chart.pillar.hour.stemElement', value: 'Holz' },
        ],
        prose:
          'In deiner Verteilung trägt das Element Feuer das größte Gewicht, während das Element Metall, dein eigener Grundstoff, ruhiger dasteht. Das Element Holz bleibt am dünnsten besetzt. Daraus entsteht eine Spannung: viel Antrieb und Hitze von außen, ein vergleichsweise schmaler eigener Vorrat, an dem sich das alles abarbeitet. Du kennst vermutlich beides, das schnelle Entflammen und das anschließende Bedürfnis, dich zurückzuziehen und nachzuschärfen. Nicht jeder Impuls, der dich erreicht, muss von dir beantwortet werden. Welcher davon verdient deine Kraft?',
        uncertaintyNotes: [],
      },
      {
        themeId: 'primary.positional_context',
        citedFacts: [
          { factId: 'chart.pillar.year.stem', value: 'Geng' },
          { factId: 'chart.pillar.year.tier', value: 'Pferd' },
          { factId: 'chart.pillar.day.branch', value: 'Hai' },
          { factId: 'chart.pillar.day.tier', value: 'Schwein' },
          { factId: 'chart.pillar.hour.stem', value: 'Yi' },
        ],
        prose:
          'Im Jahr steht der Himmelsstamm Geng, dem das Tierzeichen Pferd beigeordnet ist: die Schicht, die von außen auf dich schaut, Herkunft und früh Gelerntes. Der Erdzweig Hai in deiner Tagessäule, dem das Tierzeichen Schwein zugeordnet ist, beschreibt dagegen den Ort, an dem du privat zu Hause bist, und trifft auf einen deutlich anderen Ton. In der Stunde ergänzt der Himmelsstamm Yi eine weichere, biegsamere Bewegung. Diese Schichten widersprechen einander nicht, sie melden sich nacheinander. Welche davon meldet sich bei dir, wenn es eng wird?',
        uncertaintyNotes: [],
      },
    ],
  };
}

/**
 * The answer for the UNKNOWN-TIME chart.
 *
 * The hour pillar is provisional there, so the positional section both carries
 * a note that actually states the uncertainty and avoids every certainty word —
 * which is precisely what the provisionality gate checks.
 */
export function validUnknownTimeAnswer(): FixtureAnswer {
  return {
    sections: [
      {
        themeId: 'primary.self_role',
        citedFacts: [
          { factId: 'chart.dayMaster.stem', value: 'Xin' },
          { factId: 'chart.dayMaster.element', value: 'Metall' },
          { factId: 'chart.dayMaster.polarity', value: 'yin' },
          { factId: 'chart.natal.pillar.year.tenGod', value: 'RobWealth' },
        ],
        prose:
          'Der Tagesmeister Xin steht im Element Metall, und seine Polarität yin gibt diesem Element einen leisen, genauen Zug. Zusammen mit dem Ten God Rivale ergibt das ein Muster, in dem Vergleich und Abgrenzung eine größere Rolle spielen, als du nach außen zeigst. Du misst dich, auch wenn niemand zuschaut. Das kann anspornen und ermüden, oft am selben Tag. Woran würdest du deinen Maßstab festmachen, wenn niemand sonst im Raum wäre?',
        uncertaintyNotes: [],
      },
      {
        themeId: 'primary.seasonal_anchor',
        citedFacts: [
          { factId: 'chart.natal.monthCommand.branch', value: 'Wu' },
          { factId: 'chart.natal.monthCommand.principalQiStem', value: 'Ding' },
          { factId: 'chart.pillar.month.tier', value: 'Pferd' },
        ],
        prose:
          'Dein Monatskommando ruht auf dem Erdzweig Wu, dem das Tierzeichen Pferd zugeordnet ist. Der darin führende Himmelsstamm Ding gibt der Jahreszeit ihre Wärme. Zusammen mit dem Erdzweig Wu entsteht ein Grundton, der nach vorn drängt und schnell sichtbar wird. Die Kehrseite ist das lange Bleiben, das dir weniger leicht von der Hand geht. Was würde sich ändern, wenn du einen Anfang bewusst später setzt?',
        uncertaintyNotes: [],
      },
      {
        themeId: 'primary.elemental_profile',
        citedFacts: [
          { factId: 'chart.wuxing.dominant', value: 'Feuer' },
          { factId: 'chart.wuxing.weight.Feuer', value: '2.5' },
          { factId: 'chart.wuxing.weight.Holz', value: '1.8' },
          { factId: 'chart.dayMaster.element', value: 'Metall' },
        ],
        prose:
          'In deiner Verteilung trägt das Element Feuer das größte Gewicht, während das Element Metall, dein eigener Grundstoff, zurückhaltender bleibt. Das kleinste Gewicht entfällt auf Holz. Daraus entsteht eine Spannung zwischen Antrieb von außen und einem schmaleren eigenen Vorrat. Du kennst vermutlich beides, das rasche Entflammen und das Bedürfnis, dich danach zurückzuziehen. Welcher Impuls verdient deine Kraft?',
        uncertaintyNotes: [],
      },
      {
        themeId: 'primary.positional_context',
        citedFacts: [
          { factId: 'chart.pillar.year.stem', value: 'Geng' },
          { factId: 'chart.pillar.year.tier', value: 'Pferd' },
          { factId: 'chart.pillar.day.branch', value: 'Hai' },
          { factId: 'chart.pillar.hour.stem', value: 'Yi' },
        ],
        prose:
          'Im Jahr steht der Himmelsstamm Geng, dem das Tierzeichen Pferd beigeordnet ist, und der Erdzweig Hai in deiner Tagessäule trifft auf einen deutlich anderen Ton. In der Stunde erscheint der Himmelsstamm Yi mit einer weicheren Bewegung, doch dieser Teil ruht auf einer unsicheren Grundlage. Lies ihn als Möglichkeit, nicht als Befund. Welche der beiden Schichten meldet sich bei dir, wenn es eng wird?',
        uncertaintyNotes: [
          'Vorläufig: die Stundenangabe ist unbekannt, deshalb bleibt dieser Teil der Aussage ungewiss und wird nicht aufgelöst.',
        ],
      },
    ],
  };
}

/** Renders a fixture answer the way a provider would: bare JSON text. */
export function answerAsProviderText(answer: FixtureAnswer): string {
  return JSON.stringify(answer);
}

/**
 * One scripted provider reply.
 *
 * `status` drives the HTTP status; `body` is the raw JSON body. Everything a
 * failover test needs is expressible here, including a body that is not an
 * OpenAI-shaped completion at all.
 */
export interface ScriptedReply {
  readonly status: number;
  readonly body: unknown;
  /** When set, the transport throws this instead of answering. */
  readonly throws?: Error;
}

export interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

export interface FakeTransport extends Transport {
  readonly requests: readonly RecordedRequest[];
}

/** An OpenAI-compatible success body carrying `content`. */
export function completionBody(
  content: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'cmpl-fixture',
    model: 'fixture-model-free',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000 },
    ...overrides,
  };
}

/**
 * Re-renders a buffered completion body as the SSE stream a provider would send.
 *
 * Split into several chunks, and with the content deliberately cut mid-string,
 * so the client's line buffering is actually exercised: a parser that assumed
 * every chunk ends on a newline would pass a single-chunk fixture and fail
 * against a real provider.
 */
export function asEventStream(body: Record<string, unknown>): string {
  const choices = body['choices'] as
    | { message?: { content?: string }; finish_reason?: string }[]
    | undefined;
  const content = choices?.[0]?.message?.content ?? '';
  const finishReason = choices?.[0]?.finish_reason ?? 'stop';
  const id = body['id'];
  const model = body['model'];

  const frames: string[] = [];
  const CHUNK = 40;
  for (let at = 0; at < content.length; at += CHUNK) {
    frames.push(
      `data: ${JSON.stringify({
        id,
        model,
        choices: [{ delta: { content: content.slice(at, at + CHUNK) } }],
      })}\n\n`,
    );
  }
  frames.push(
    `data: ${JSON.stringify({ id, model, choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
  );
  if (body['usage'] !== undefined) {
    frames.push(`data: ${JSON.stringify({ id, model, choices: [], usage: body['usage'] })}\n\n`);
  }
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

/**
 * A transport that replays a script and records what it was asked.
 *
 * Recording the requests is the point: the failover tests assert that every
 * route received the SAME prompt, and an assertion about that needs the actual
 * bodies rather than a claim about them.
 *
 * It answers a streaming REQUEST with a streaming RESPONSE, exactly as a real
 * provider does, so a scripted reply written as a buffered completion body is
 * served correctly either way and no test has to know which transport mode the
 * production default happens to use. Non-200 replies stay plain JSON, which is
 * also what real providers do: an error is not streamed.
 */
export function fakeTransport(script: readonly ScriptedReply[]): FakeTransport {
  const requests: RecordedRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch(url: string, init: RequestInit): Promise<Response> {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({
        url,
        authorization: headers['Authorization'] ?? null,
        body,
      });
      const reply = script[index] ?? script[script.length - 1];
      index += 1;
      if (reply === undefined) {
        throw new Error('fixture defect: empty transport script');
      }
      if (reply.throws !== undefined) {
        return Promise.reject(reply.throws);
      }
      const streaming =
        body['stream'] === true &&
        reply.status === 200 &&
        typeof reply.body === 'object' &&
        reply.body !== null;
      if (streaming) {
        return Promise.resolve(
          new Response(asEventStream(reply.body as Record<string, unknown>), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  };
}

/** The environment record the route-plan tests use. Fake values only. */
export const FIXTURE_LLM_ENV: Readonly<Record<string, string>> = {
  TOKENROUTER_BASE_URL: 'https://provider.invalid/one/v1',
  TOKENROUTER_MODEL: 'vendor/model-a-free',
  TOKENROUTER_API_KEY: 'fixture-key-one',
  GEMINI_BASE_URL: 'https://provider.invalid/two/v1/',
  GEMINI_MODEL: 'vendor-model-b',
  GEMINI_API_KEY: 'fixture-key-two',
  OPENCODE_BASE_URL: 'https://provider.invalid/three/v1',
  OPENCODE_PRIMARY_MODEL: 'model-c-free',
  OPENCODE_API_KEY: 'fixture-key-three',
  OPENROUTER_BASE_URL: 'https://provider.invalid/four/v1',
  OPENROUTER_MODEL: 'vendor/model-d:free',
  OPENROUTER_API_KEY: 'fixture-key-four',
  // Route 5 is configured and DELIBERATELY INELIGIBLE, the same technique the
  // gemini route above uses — and with a sharper model id. `glm-4.7-flashx` is a
  // real, PAID Z.ai model whose name differs from the free `glm-4.7-flash` by
  // one character, so the fixture itself encodes the counterexample the
  // allowlist exists to refuse: a route whose id would pass any prefix,
  // substring or "-flash means free" test is refused here by exact-id equality.
  // The endpoint is fake; the model id is real because the trap is real.
  ZAI_BASE_URL: 'https://provider.invalid/five/v1',
  ZAI_MODEL: 'glm-4.7-flashx',
  ZAI_API_KEY: 'fixture-key-five',
  LLM_ALLOW_PAID: 'false',
  LLM_PAID_COST_CAP_USD: '0',
};
