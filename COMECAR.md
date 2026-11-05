# Experimentar o Blackbox

1. Abre **Start-Blackbox.cmd**.
2. Entra em **http://127.0.0.1:9090** no browser.
3. Mantém **The lost response** e **Unprotected** selecionados.
4. Clica em **Run experiment**. O resultado mostra dois treinos guardados: a resposta perdeu-se, o cliente repetiu o pedido e criou um duplicado.
5. Seleciona **Idempotent** e executa novamente. Agora fica apenas um treino, porque as duas tentativas usam a mesma chave.

A falha do primeiro caso é intencional: é precisamente o problema que a experiência demonstra.

Na versão 0.2, abre **Experiments** na barra lateral para comparar os dois resultados. Podes escolher qualquer execução como referência **A** e comparação **B**, exportar o resultado ou usar **Restore setup** para recuperar as regras e o modo do cliente. A aplicação avisa quando as configurações são diferentes. Os resultados antigos continuam disponíveis; só as novas execuções incluem uma cópia das regras.

Experimenta também **The slow lane** e **Third time lucky**. Clica numa linha do fluxo de pedidos para comparar a resposta do servidor com aquilo que chegou ao cliente.

Esta versão já inclui o executável Windows. Não precisas de instalar Go, Node.js ou uma base de dados para a usar. Mantém o terminal aberto enquanto experimentas e usa **Ctrl+C** para parar.

Os dados são locais e ficam na pasta `.blackbox`. A demonstração usa uma API própria com dados fictícios. O projeto está preparado para apontar o proxy a outra API; consulta o [README](README.md) para os comandos, arquitetura e limites.

O código e a documentação estão em inglês para facilitar a apresentação no portefólio.

## Integração real com o Fitness Tracker — v0.3

Para ver os resultados já obtidos, abre `docs/evidence/fitness/report.html`. O relatório mostra os três cenários, as 42 verificações e os dados observados. Clica em **Play 75-second walkthrough** para uma apresentação automática. Não precisas de instalar dependências para abrir este relatório.

Para repetir as experiências, com Python, Git e PostgreSQL 18 instalados, executa na pasta do projeto:

```powershell
python integrations/fitness/start.py --postgres-bin "C:\Program Files\PostgreSQL\18\bin"
```

O comando prepara o backend original, cria uma base de dados isolada, executa os testes e imprime o caminho para um novo relatório. No final, para os processos que criou. A primeira execução precisa de internet para descarregar dependências. O PostgreSQL habitual do computador não é usado nem parado.

O teste simula um cliente que repete pedidos e dois dispositivos concorrentes; ainda não executa a aplicação móvel. Consulta as [instruções completas](integrations/fitness/README.md) para Docker, requisitos e diagnóstico, e o [guião da apresentação](docs/demo-script.md) para explicares o projeto.
