# 75-second portfolio demonstration

Open a generated `report.html` and click **Play 75-second walkthrough**. The five slides each last 15 seconds and read their figures from that run. Pause/Resume, Next and Close work without a server or internet connection. The recording is a walkthrough of captured evidence, not a claim that the browser is executing new experiments.

The checked-in [example report](evidence/fitness/report.html) can be used immediately. Its JSON download is embedded, so the HTML can be shared on its own. Generate fresh results with the [integration command](../integrations/fitness/README.md) before recording a new revision.

The [silent video recording](images/fitness-demo.webm) is ready to share. It shows the same recorded evidence at 1280 × 720. To record again after installing the frontend development dependencies and Playwright FFmpeg:

```sh
cd web
npx playwright install ffmpeg
cd ..
node scripts/record-fitness-demo.mjs
```

The recorder uses installed Chrome by default; `BLACKBOX_BROWSER_CHANNEL` can select another installed Playwright channel. Optional arguments are the input report HTML path and output WebM path. Use the narration below to add your own voice.

| Time | Screen | Suggested narration in Portuguese |
| --- | --- | --- |
| 00–15 s | Question and architecture | “O Blackbox permite provocar falhas HTTP de forma controlada. Aqui liguei-o ao backend real do meu Fitness Tracker, com PostgreSQL. A pergunta é: o que acontece se o servidor guardar uma alteração, mas o cliente nunca receber a resposta?” |
| 15–30 s | Lost response | “O primeiro pedido foi guardado. O proxy perdeu a resposta de propósito. O cliente repetiu exatamente a mesma alteração, com o mesmo mutation_id. Verifiquei a base de dados antes e depois: a versão só aumentou uma vez.” |
| 30–45 s | Temporary 503s | “Neste caso, o proxy devolveu dois erros 503 antes de contactar a API. A base de dados ficou intacta nas duas tentativas. Com espera entre tentativas, o terceiro pedido conseguiu guardar a alteração.” |
| 45–60 s | Concurrent edits | “Agora simulei dois dispositivos a alterar a mesma versão do treino. Uma alteração foi aceite. A outra recebeu um conflito 409. A alteração vencedora ficou preservada, sem duplicar séries.” |
| 60–75 s | Evidence and scope | “Os três cenários passaram 42 verificações. O relatório reúne pedidos, falhas e consultas à base de dados. Tudo pode ser repetido por comando. Isto testa o backend; o cliente móvel é uma etapa de validação separada.” |

For an interview, expand the lost-response assertions afterward. Show the upstream `200`, downstream `0`, and the PostgreSQL checkpoint **before** retry. That is the evidence connecting the injected failure to the persisted result.

Useful follow-up discussion: why the mutation receipt is checked before the expected version; why a 409 should not be blindly retried; why the experiment uses PostgreSQL; and why a network error cannot tell the client whether a commit happened.
