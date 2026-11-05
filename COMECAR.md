# Experimentar o Blackbox

1. Abre **Start-Blackbox.cmd**.
2. Entra em **http://127.0.0.1:9090** no browser.
3. Mantém **The lost response** e **Unprotected** selecionados.
4. Clica em **Run experiment**. O resultado mostra dois treinos guardados: a resposta perdeu-se, o cliente repetiu o pedido e criou um duplicado.
5. Seleciona **Idempotent** e executa novamente. Agora fica apenas um treino, porque as duas tentativas usam a mesma chave.

A falha do primeiro caso é intencional: é precisamente o problema que a experiência demonstra.

Experimenta também **The slow lane** e **Third time lucky**. Clica numa linha do fluxo de pedidos para comparar a resposta do servidor com aquilo que chegou ao cliente.

Esta versão já inclui o executável Windows. Não precisas de instalar Go, Node.js ou uma base de dados para a usar. Mantém o terminal aberto enquanto experimentas e usa **Ctrl+C** para parar.

Os dados são locais e ficam na pasta `.blackbox`. A demonstração usa uma API própria com dados fictícios. O projeto está preparado para apontar o proxy a outra API; consulta o [README](README.md) para os comandos, arquitetura e limites.

O código e a documentação estão em inglês para facilitar a apresentação no portefólio.
