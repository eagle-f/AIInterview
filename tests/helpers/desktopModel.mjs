import { createServer } from 'node:http';
import { once } from 'node:events';

/** Local OpenAI-compatible fixture for the actual desktop window; never calls a provider. */
export async function startDesktopModel() {
  const requests = [];
  let replyCalls = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      if (!body.stream) {
        const transcript = JSON.parse(body.messages.find((message) => message.role === 'user').content).transcript;
        const answer = transcript.find((message) => message.role === 'user');
        const feedback = {
          summary: '桌面测试：你说明了组件库维护职责和验证方法，可以进一步展开具体案例。',
          dimensions: ['technical', 'project', 'reasoning', 'communication'].map((id) => ({
            id, level: id === 'project' ? 'developing' : 'not_covered',
            assessment: id === 'project' ? '说明了工作职责和回归验证方法。' : '本轮尚未展开该维度。',
            strengths: id === 'project' ? ['能说明个人职责。'] : [],
            improvements: ['结合一个具体问题展开说明。'],
            evidence: id === 'project' ? [{ messageId: answer.id, quote: answer.content }] : [],
          })),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'desktop-report', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(feedback) }, finish_reason: 'stop' }] }));
        return;
      }
      // The first opening is deliberately truncated to exercise UI recovery.
      if (body.response_format?.type !== 'json_object' && ++replyCalls === 1) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ id: 'truncated-opening', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] }) + '\n\n');
        return;
      }
      const content = body.response_format?.type === 'json_object' ? '{}' : '请举一个组件库维护中的具体问题，并说明你如何验证修复效果。';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const delta of [content.slice(0, 6), content.slice(6)]) {
        res.write(`data: ${JSON.stringify({ id: 'desktop-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: 'desktop-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
