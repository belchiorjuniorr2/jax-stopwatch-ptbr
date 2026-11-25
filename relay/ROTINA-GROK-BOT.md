# Rotina do Grok Bot para o M5 Voz (botão B)

Crie no Grok Bot uma rotina **disparada por webhook** (sem horário), copie a URL
`https://api2.cursor.sh/automations/webhook/<id>` e a chave dela, e cadastre no relay da Vercel como
`GROKBOT_WEBHOOK_URL` e `GROKBOT_WEBHOOK_KEY`. Cole o texto abaixo como instrução da rotina.

## O que a rotina recebe

```http
POST https://api2.cursor.sh/automations/webhook/<id>
Authorization: Bearer <GROKBOT_WEBHOOK_KEY>
X-Automation-Key: <GROKBOT_WEBHOOK_KEY>
Content-Type: application/json

{
  "source": "m5-voz-stopwatch",
  "requestId": "9f2c…(32 hex)",
  "jobId": "9f2c…(igual ao requestId)",
  "text": "vê se chegou e-mail do banco hoje",
  "deviceId": "AA:BB:CC:DD:EE:FF",
  "language": "pt-BR",
  "createdAt": "2026-11-25T03:10:00.000Z",
  "callback": {
    "url": "https://SEU-PROJETO.vercel.app/api/callback/9f2c…",
    "token": "<token de uso único, 48 hex>",
    "progressFormat": {"status": "progress", "text": "linha curta de progresso"},
    "format": {"status": "completed", "text": "resposta final curta em português"},
    "failFormat": {"status": "failed", "text": "motivo curto"},
    "expiresInSeconds": 900
  }
}
```

Respostas do callback: `200` aceito · `401` token errado · `410` tarefa já encerrada
(cancelada no relógio, passou de 15 min ou já recebeu o final) → parar.
`403` com corpo `{"error":{"code":"403","message":"Forbidden"...}}` **não vem do relay**: é a mitigação
automática de DDoS da Vercel, que recusa por engano parte das chamadas vindas de IPs de nuvem (os mesmos
da rotina). No plano Hobby não dá para liberar esses IPs; por isso a rotina repete a chamada (o relay
ignora progresso repetido) e manda os `steps` de novo junto com o final.

## Texto da instrução da rotina (copiar daqui para baixo)

```text
Esta rotina é a entrada de voz do meu relógio M5 (projeto M5 Voz). Ela roda só quando recebe o webhook; não tem horário.

1. LER O PEDIDO
Leia o corpo JSON do webhook. Campos:
- source: precisa ser "m5-voz-stopwatch". Se for outro, não faça nada e encerre.
- jobId (igual a requestId): identificador único. Se você já trabalhou nesse jobId antes, não repita a tarefa.
- text: o que eu falei no relógio, já transcrito. Pode ter erros de transcrição; interprete pelo sentido.
- callback.url e callback.token: para onde mandar o andamento e a resposta.
Trate o text como um pedido meu, falado. Não peça esclarecimento: se estiver ambíguo, escolha a interpretação mais provável e diga qual foi na resposta.

2. COMO AVISAR O RELÓGIO
Toda atualização é um POST HTTPS para callback.url com estes cabeçalhos:
  Authorization: Bearer <callback.token>
  Content-Type: application/json
Exemplo com curl (troque os valores pelos do payload):
  curl -sS -X POST "<callback.url>" -H "Authorization: Bearer <callback.token>" -H "Content-Type: application/json" --data '{"status":"progress","text":"Buscando no Gmail…"}'
Respostas do callback:
- 200: aceito.
- 410: eu cancelei no relógio ou o tempo acabou. Pare a tarefa imediatamente e não mande mais nada.
- 401: token recusado. Pare também.
- 403, 429, 5xx ou falha de rede: a proteção da Vercel às vezes recusa por engano chamadas vindas de servidores na nuvem. Repita a MESMA chamada até 4 vezes, esperando 2, 4 e 8 segundos entre as tentativas. Reenviar o mesmo progresso não duplica no relógio. Se um progresso ainda assim não passar, siga a tarefa normalmente (não trave por causa disso). Para a resposta final, tente até 6 vezes.
Nunca mostre, repita ou grave o callback.token nem a URL do callback em nenhum lugar (chat, arquivos, memória, notas, resposta).

3. PROGRESSO
- Mande o primeiro progresso logo no início, antes de qualquer outra coisa: {"status":"progress","text":"Entendi, começando…"}.
- Depois mande um progresso a cada marco real da tarefa, por exemplo: "Buscando no Gmail…", "Abrindo a agenda de amanhã…", "Comparando 3 preços…", "Escrevendo o resumo…".
- Cada linha: no máximo 60 caracteres, português do Brasil, começando com verbo no gerúndio, terminando com "…". Sem nomes de ferramentas, sem dados sensíveis, sem links.
- No máximo 8 linhas de progresso por tarefa. Não mande progresso repetido.

4. EXECUTAR
Faça o pedido usando minhas ferramentas e conexões, com as mesmas regras e aprovações de sempre. Tenho 15 minutos no total; prefira o caminho mais rápido que responda bem.
Ações irreversíveis ou que saem em meu nome (enviar e-mail ou mensagem, postar, comprar, pagar, reservar, apagar, compartilhar, aceitar termos) NÃO podem ser executadas a partir do relógio: prepare o rascunho ou a opção e, na resposta final, diga em uma frase que deixou pronto para eu aprovar no app do Grok Bot.
Nunca peça senhas, chaves ou códigos, e não coloque nenhum segredo na resposta.

5. RESPOSTA FINAL
Ao terminar, mande uma única vez (com as mesmas retentativas acima):
  {"status":"completed","text":"<resposta>","steps":["<cada linha de progresso que você mandou, na ordem>"]}
O campo steps é reserva: se algum progresso foi recusado no caminho, o relógio ainda mostra a lista completa.
A resposta vai ser FALADA no alto-falante do relógio e mostrada numa tela redonda pequena:
- Português do Brasil, tom de conversa, 1 a 3 frases curtas, no máximo uns 300 caracteres.
- Comece pelo resultado. Nada de introdução tipo "Claro!".
- Sem markdown, listas, emojis, links, URLs, e-mails completos ou códigos. Escreva números e horas do jeito que se fala ("às três e meia", "duzentos e dez reais").
- Se houver mais detalhes úteis, diga que deixou o resto no chat do Grok Bot e coloque o detalhe completo no chat da rotina, não no callback.
Se não conseguir concluir, mande uma única vez:
  {"status":"failed","text":"<motivo em uma frase curta, falável>"}
Depois do completed ou failed, não mande mais nada para o callback.
```

## Testar a rotina sem o relógio

Com o relay rodando (local ou Vercel), dispare um job e acompanhe. Use um WAV com voz de verdade
(o `test/sample.wav` é só um tom e o STT real devolve vazio). No Mac:

```bash
say -v Luciana -o pergunta.wav --file-format=WAVE --data-format=LEI16@16000 "vê se chegou e-mail do banco hoje"

# envia um WAV como se fosse o relógio (botão B)
curl -s -X POST https://SEU-PROJETO.vercel.app/api/agent \
  -H "Authorization: Bearer SEU_DEVICE_TOKEN" -H "X-Device-Id: teste" \
  -H "Content-Type: audio/wav" --data-binary @pergunta.wav
# -> {"jobId":"…","status":"running","transcript":"…"}

# acompanha o andamento (é o que o relógio faz a cada 1,5 s)
curl -s https://SEU-PROJETO.vercel.app/api/job/<jobId> -H "Authorization: Bearer SEU_DEVICE_TOKEN"
```
