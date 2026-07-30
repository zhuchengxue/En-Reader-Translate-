/* 调试端点：测试 Workers AI 绑定是否生效。GET /api/ai-test 返回 AI 状态。 */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }
  const result = { aiBound: false, aiResult: '', error: '' };
  const ai = context.env && context.env.AI;
  result.aiBound = typeof ai !== 'undefined';
  if (ai) {
    try {
      const resp = await ai.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [
          { role: 'user', content: 'Say "ok" in Chinese, one word only.' }
        ],
        max_tokens: 20
      });
      result.aiResult = typeof resp === 'object' ? JSON.stringify(resp).slice(0, 200) : String(resp).slice(0, 200);
    } catch (e) {
      result.error = String(e.message || e).slice(0, 200);
    }
  }
  return new Response(JSON.stringify(result), { headers: { ...cors, 'Content-Type': 'application/json' } });
}
