import type { LLM } from '@aura/core';
import { type EvalCache, sha } from './cache';
import { type Question, isAbstention } from './dataset';

// Judge prompts adapted from LongMemEval's evaluate_qa.py (one per question type).
// One fixed judge for every run, temperature 0, output constrained to yes/no.

const BASE = (q: string, a: string, r: string, extra = '') =>
  `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.${extra}\n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;

export function judgePrompt(q: Question, response: string): string {
  const answer = String(q.answer);
  if (isAbstention(q))
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${q.question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  switch (q.question_type) {
    case 'temporal-reasoning':
      return BASE(q.question, answer, response, ' In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model\'s response is still correct.');
    case 'knowledge-update':
      return BASE(q.question, answer, response, ' If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.');
    case 'single-session-preference':
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${q.question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    default:
      return BASE(q.question, answer, response);
  }
}

export class Judge {
  constructor(private llm: LLM, private cache: EvalCache) {}
  get id() { return this.llm.id; }

  async judge(q: Question, response: string): Promise<boolean> {
    const prompt = await this.llm.applyTemplate([{ role: 'user', content: judgePrompt(q, response) }], { thinking: false });
    const key = sha(this.llm.id, prompt);
    const hit = this.cache.get('judge', key);
    if (hit) return hit.toString() === 'yes';
    const r = await this.llm.complete({ prompt, maxTokens: 3, temperature: 0, grammar: 'root ::= "yes" | "no"' });
    const verdict = r.text.trim().toLowerCase().startsWith('yes') ? 'yes' : 'no';
    this.cache.put('judge', key, verdict);
    return verdict === 'yes';
  }
}
