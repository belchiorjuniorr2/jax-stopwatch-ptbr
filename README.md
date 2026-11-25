# M5 Voz — sistema instalado no M5Stack StopWatch

Documentação do que o relógio **faz hoje**, com base no firmware e no relay realmente gravados, não em planos ou no Jax original (que dependia de um Mac).

Idioma da interface e das respostas: **português do Brasil**. Fuso do relógio: **America/Sao_Paulo (UTC−3, horário de Brasília)**, relógio em 24 horas.

## Resumo

O M5Stack StopWatch virou um assistente de voz que fala sozinho, sem o Mac no dia a dia. Basta Wi-Fi de 2,4 GHz (o ESP32-S3 não enxerga 5 GHz). As redes, a URL do relay e o token do dispositivo ficam no firmware (`firmware/src/config_relay.h`); as chaves dos provedores ficam só no servidor.

- **Botão A (amarelo, frente, G2), segurar e falar:** caminho rápido via ChatGPT no relay (`/api/voz`).
- **Botão B (lateral, G1), segurar e falar:** caminho do Grok Bot (`/api/agent` + rotina **M5 Voz (relógio)**).
- Enquanto escuta, pensa ou responde, o rosto **congela** e no rodapé aparece só o status: `Escutando...`, `Pensando...` ou `Respondendo...`. A pergunta e a resposta aparecem no balão de fala.
- O áudio da resposta é **tocado aos pedaços** enquanto baixa (3 buffers de 32 KB). Respostas longas não precisam caber inteiras na PSRAM.

## Build instalado

| Item | Valor |
| --- | --- |
| Aparelho | M5Stack StopWatch, ESP32-S3, PSRAM OPI de 8 MB, tela AMOLED redonda 466×466 |
| Firmware | Jax StopWatch pt-BR, a partir do `stackchan-pet-fw` 0.4.1 (`STACKCHAN_FIRMWARE_VERSION`) |
| Ambiente de compilação | PlatformIO `m5stack-stopwatch-release` em `firmware/` |
| SHA-256 do app | `74cffd632e318a954d4871d943dc8e05410aed983f3315c1bc361cae5b04f0b5` |
| Tamanho do app | 1.743.168 bytes (cerca de 66,5% da partição de 2,5 MiB em `0x10000`) |
| Compilado | 25/11/2026, 19:35 (horário de Brasília) |
| Gravado no relógio | 25/11/2026, 19:39 (horário de Brasília), só o app em `0x10000` (LittleFS intocado) |
| Relay | `https://m5-voz-relay.vercel.app` |
| Pilha da `loopTask` | 32 KB (`ARDUINO_LOOP_STACK_SIZE`) |

O binário correspondente está em:

`firmware/.pio/build/m5stack-stopwatch-release/firmware.bin`

Há cópias mais antigas em `out-bin/`. **Não grave** `out-bin/jax-stopwatch-ptbr-app.bin` por cima desta versão: o SHA é outro.

## Independência do Mac

No uso diário o Mac **não entra**. O relógio conecta no Wi-Fi com a lista gravada em `firmware/src/config_relay.h` (`WiFiMulti`, várias redes de 2,4 GHz) e fala com o relay na Vercel por HTTPS, com validação de certificado.

O firmware ainda contém o caminho antigo de ponte com o Mac (USB-serial / NetLink, PTT se um cliente Mac estiver ligado, badges de aviso). Esses trechos só entram se um Mac/app se conectar. A rotina de Wi-Fi/HTTP/WebSocket do Jax original (`connectWiFi` / `updateWiFi`) retorna logo no começo e **não sobe** o portal SoftAP nem os servidores locais no uso normal.

Ao **apagar a tela**, o firmware desliga o rádio Wi-Fi e reduz a CPU para 80 MHz. Ao ligar de novo, o relógio reconecta sozinho (pode levar alguns segundos; aparece `Procurando Wi-Fi...`).

## Tela inicial

Layout pensado para o círculo de 466×466:

- **Centro:** o avatar (rosto padrão do LittleFS, ou outro gravado no relógio). Em descanso o idle/piscar continua. Durante a voz o último quadro fica **congelado** — sem decodificar JPEG, sem loop de fala — para não encher a PSRAM nem atrasar o microfone.
- **Topo:** horário `HH:MM` em 24 h, sincronizado por NTP (`pool.ntp.org` e `time.google.com`) no fuso de Brasília, depois que o Wi-Fi sobe.
- **Rodapé:** nome do agente (`ChatGPT` ou `Grok Bot`), ícone de ligação e bateria com porcentagem. Se houver mais de um avatar, aparecem pontinhos acima dessa faixa.
- **Toque na tela inicial:**
  - um toque no rosto: risadinha; três toques seguidos: gargalhada;
  - deslizar para os lados: troca o avatar (quando há mais de um);
  - segurar a **faixa do relógio** no topo (cerca de 800 ms, sem arrastar): abre os **Ajustes**.

Animações de inclinar a cabeça, tontura, sacudir e carinho contínuo estão **desligadas** neste build (`STACKCHAN_MAC_BRIDGE_HOME`). O medidor de afeição também está desligado no StopWatch.

## Botões

O limiar de “segurar” nos botões A e B é **350 ms**. Segurar A e B juntos **não reinicia** o relógio.

| Ação | O que faz |
| --- | --- |
| Segurar **A** (amarelo, frente, G2) e falar; soltar para enviar | Caminho rápido ChatGPT (`/api/voz`) |
| Segurar **B** (lateral, G1) e falar; soltar para enviar | Caminho Grok Bot (`/api/agent`) |
| O outro botão enquanto grava, ou A/B / A+B / clique duplo em B no meio da sessão | Cancela (`Cancelando...`). Se a rotina do Grok Bot já tiver começado, ela pode terminar lá mesmo |
| Clique duplo em **B** (em descanso) | Nova conversa: `POST /api/reset` e o balão `Nova conversa` |
| Clique curto em **A** | Só tenta repetir a última resposta se o PCM ainda estiver na memória. Depois do TTS em streaming o áudio é liberado, então **em geral não há replay** |
| **A+B** segurados juntos | Abre os Ajustes; não começa gravação e não reinicia |
| Clique curto em **A** com os Ajustes abertos | Fecha os Ajustes |
| Botão de **energia** (topo) | Liga ou apaga a tela. Com a tela apagada, um clique no **B** também acorda. O A não acorda a tela neste aparelho |
| Ajustes → Tela → **Desligar** | Apaga a tela (mesmo efeito do botão de energia) |

Depois de 1 minuto sem uso a tela apaga (mesmo caminho do botão de energia). Em Ajustes → Tela dá para escolher 30 s, 1 min, 2 min ou nunca (padrão 1 min, gravado no NVS). Não apaga durante Escutando / Pensando / Respondendo nem enquanto um job do Grok Bot está pendente.

## Fluxo de voz

1. **Escutando...** — o StreetPass BLE é pausado, o microfone grava PCM 16 kHz mono (`magnification = 1`, depois normaliza o volume, no máximo uns 8×). Limite: **30 segundos** (cerca de 960 KB na PSRAM). Se a fala ficar curta demais, aparece `A gravacao ficou curta. Segure o botao e fale a frase.` Fale a cerca de **15 cm**, principalmente no botão B: o nível do microfone nesse caminho ainda sai mais baixo.
2. **Pensando...** — o relógio envia o WAV ao relay. No balão aparece `Você: ` + a transcrição, quando ela já veio. No caminho B, o andamento da rotina também entra no balão (últimos passos).
3. **Respondendo...** — o TTS chega em streaming para o alto-falante, em 3 buffers de 32 KB (cerca de 3 s de áudio a 16 kHz). O texto da resposta vai no balão (com rolagem se passar de 7 linhas). Se o Grok Bot não devolver áudio, o texto fica na tela por alguns segundos.

O cache do rosto “falando” é liberado antes e depois do TTS, para não dar `PSRAM cheia`. Essa mensagem só aparece se a PSRAM estiver de fato esgotada (menos de 64 KB livres ou bloco contínuo menor que 16 KB); caso contrário o firmware fala em `Falta memoria pro audio`.

A reprodução do relay liga o alto-falante em volume 255. O slider de **Volume** nos Ajustes é salvo e vale para o `AudioController` do aparelho, mas **não** é o que o caminho de voz do relay usa hoje.

Depois de uma resposta ok, o rosto mostra a expressão feliz por cerca de 1,6 s e volta ao idle.

### Acentos (pt-BR)

O DejaVu 12 embutido no M5GFX é só ASCII. O firmware usa a fonte **PtBrDejaVu12**, recorte Latin-1 (U+0020–U+00FF) do DejaVu Sans 12 px, nos status e no balão. Assim `você`, `ação`, `não` etc. aparecem corretamente. O comando de teste `TEST ACCENT` mostra o status `Acentuação` e o texto `Você está ótimo, ação, não`.

## Relay (`https://m5-voz-relay.vercel.app`)

Código em `relay/`. Funções Vercel com até 60 s e 1024 MB. O relógio autentica com `Authorization: Bearer` (token configurado) e `X-Device-Id` (endereço MAC). **Nenhuma chave de provedor vai no firmware.**

| Endpoint | Função |
| --- | --- |
| `GET /api/health` | Checagem ao conectar. O relógio mostra `Relay ok` (ou tenta até 5 vezes) |
| `POST /api/voz` | Caminho A: STT → LLM com histórico → TTS. Devolve WAV (e cabeçalhos `X-Transcript`, `X-Reply`) |
| `POST /api/agent` | Caminho B: STT, cria o job no KV, dispara o webhook da rotina. Resposta 202 com `jobId` |
| `GET /api/job/<id>` | O relógio consulta o andamento a cada 1,5 s, no máximo 15 minutos |
| `GET /api/job/<id>/audio` | TTS do texto final, gerado na hora, também em streaming no relógio |
| `POST /api/job/<id>/cancel` | Cancelamento pedido no relógio |
| `POST /api/callback/<id>` | A rotina do Grok Bot manda progresso / conclusão / falha (token de uso único) |
| `POST /api/reset` | Apaga a memória curta daquele dispositivo |

`RELAY_URL_LAN` está vazio neste aparelho: não há fallback para um relay na rede local.

### Provedores (só os nomes)

A escolha vem das variáveis de ambiente da Vercel (`STT_PROVIDER`, `LLM_PROVIDER`, `TTS_PROVIDER`). Se vierem vazias, o código escolhe automaticamente pelas chaves presentes:

- **STT:** OpenAI (padrão do código: `gpt-4o-mini-transcribe`, idioma `pt`).
- **LLM (caminho A):** OpenAI (padrão `gpt-4o-mini`) ou xAI, se essa for a chave configurada.
- **TTS (caminhos A e B, inclusive `/audio`):** OpenAI (padrão `gpt-4o-mini-tts`) ou ElevenLabs, se essa chave existir.

O prompt padrão do caminho A pede respostas curtas em pt-BR, 1 a 3 frases, sem markdown e sem emoji, porque o texto é falado e cabe numa tela redonda pequena.

### Memória de conversa

- Até **6 turnos**, com validade de **30 minutos** (`MEMORY_TURNS=6`, `MEMORY_TTL_SECONDS=1800`).
- Guardada no **Upstash KV**.
- O caminho **A** (`/api/voz`) **lê e grava** esse histórico na hora de montar o LLM.
- O caminho **B** **não envia** o histórico para a rotina do Grok Bot (vai só o texto transcrito daquele pedido). Quando o job termina com sucesso, o turno ainda é **acrescentado** no mesmo depósito; uma pergunta seguinte pelo botão A pode lembrar disso. Clique duplo em B (ou `POST /api/reset`) limpa a memória.

## Rotina “M5 Voz (relógio)”

É uma rotina do Grok Bot **disparada por webhook**, sem horário. O relay manda o texto transcrito e um callback de uso único. A rotina:

1. trata o texto como um pedido falado (e tenta interpretar erros de transcrição);
2. avisa o relógio com linhas curtas de progresso (`Entendi, começando…`, etc.);
3. usa as ferramentas e conexões do Grok Bot, no prazo de 15 minutos;
4. devolve uma resposta **curta e falável** em pt-BR (1 a 3 frases, da ordem de 300 caracteres). Por isso pedidos longos (um resumo grande do dia, uma história comprida) saem **resumidos** no relógio; o detalhe, se houver, fica no chat da rotina.

Regra gravada na instrução da rotina: dá para **consultar e preparar** o que você pediu por voz, mas **não executa** do relógio ações irreversíveis ou que saiam no seu nome — enviar e-mail ou mensagem, postar, comprar, pagar, reservar, apagar, compartilhar ou aceitar termos. Nesses casos ela deixa o rascunho ou a opção pronta para você aprovar no app do Grok Bot. Também não pede senha, chave ou código, e não coloca segredo na resposta falada.

## Ajustes

Abrir: **A+B**, ou segurar a faixa do relógio no topo. Fechar: clique curto no **A**, ou voltar para a tela inicial. Páginas no círculo (toque em `<` `>` ou deslize para os lados), nesta ordem:

1. **Rede** — com Wi-Fi do relay ok: nome da rede, IP, `Relay: Vercel`, lembrete `A: ChatGPT  ·  B: Grok Bot` e `A+B ou relogio: ajustes`. Sem conexão, ainda existe a tela antiga de SoftAP/QR (legado). **Não segure** essa página: o toque longo ainda chama a troca STA/SoftAP e **reinicia** o relógio, embora o portal SoftAP não seja o caminho do dia a dia.
2. **Tela** — brilho; indica `Horario: 24 h` e `Fuso: Brasilia (UTC-3)`; botão **Desligar** / **Ligar tela**.
3. **Avatar** — avatar atual e troca (ou deslize na tela inicial, se houver mais de um).
4. **Audio** — volume do aparelho (ver ressalva acima sobre o TTS do relay).
5. **Energia** — temperatura do chip/PMIC, bateria, se está carregando; **Vibração** (desligada por padrão); modo **Eco**.
6. **Passos** — passos de hoje, histórico de até 30 dias, virada do dia às **04:00**. Contagem pelo IMU, com a escala deste aparelho (17/10).
7. **Encontros** (StreetPass por BLE) — liga/desliga, perfil (nome padrão `StopWatch`, mensagem padrão `Ola`, nome BLE `StopWatch StreetPass`), até 30 encontros guardados. O rádio é pausado durante a gravação e o TLS do relay, e volta depois. Com a tela apagada o StreetPass pode continuar num modo mais econômico.

Brilho, volume, vibração e eco são salvos na memória NVS do relógio (`Preferences`).

## Comandos de teste (USB)

Chegam pela serial USB (o parser do firmware encaminha linhas que começam com `TEST`). Servem para laboratório, não para o uso diário.

| Comando | Efeito |
| --- | --- |
| `TEST PING` | Responde `pong` |
| `TEST HOLD_A [s]` / `TEST HOLD_B [s]` | Gravação forçada (padrão 10 s) |
| `TEST SETTINGS` / `TEST SETTINGS_CLOSE` | Abre / fecha Ajustes |
| `TEST AVATAR` | Passa para o próximo avatar |
| `TEST REPLAY` / `TEST RESET` / `TEST CANCEL` | Replay, nova conversa, cancela a sessão |
| `TEST CLOCK` | Imprime hora e fuso na serial |
| `TEST STATUS` / `TEST MEM` | Estado da sessão / uso de heap e PSRAM |
| `TEST ACCENT` | Teste visual dos acentos |
| `TESTWAV [AGENT] <bytes>` | Envia um WAV pela serial para o caminho A ou B; se os bytes pararem, estoura em **8 s** (`wav_timeout`) |

## Memória, estabilidade e testes desta gravacão

Depois de gravar esta SHA, o relógio passou em **15 ciclos seguidos**, alternando os botões A e B. Todas as respostas saíram faladas, inclusive duas longas de cerca de 21 s. Não apareceu `PSRAM cheia`, o relógio não reiniciou, e a PSRAM voltou ao patamar de antes depois de cada resposta.

Correções que estão neste build:

- pilha da loop em 32 KB (a de 8 KB estourava ao decodificar o JPEG do rosto durante a gravação);
- microfone com bloco reafirmado, `mag=1` + normalização (o `mag=4` ceifava e embaralhava o STT);
- StreetPass pausado na gravação e no TLS;
- rosto congelado + status no rodapé durante a voz;
- TTS em streaming (3×32 KB) e cache de fala liberado no idle e antes do TTS;
- fonte Latin-1 para acentos.

## Limitações conhecidas

- A tela apaga sozinha após o tempo escolhido em Ajustes → Tela (padrão 1 min; opções 30 s, 1 min, 2 min ou nunca).
- Ao apagar a tela o Wi-Fi cai e precisa reconectar ao ligar.
- Retentativas TLS com erro `ssl -76` podem aparecer no log; são inofensivas se o health/pedido em seguida funcionar.
- No botão B, fale mais perto (cerca de 15 cm): o nível do microfone sai mais baixo.
- Respostas longas do Grok Bot chegam **resumidas** no relógio, de propósito (caber na fala e na tela).
- Clique curto em A em geral **não** repete a última fala, porque o streaming solta o PCM no fim.
- O ESP32-S3 só usa Wi-Fi 2,4 GHz.
- Segurar a página **Rede** ainda reinicia o relógio (legado).

## Pinos da tampa traseira

Sinal **somente 3,3 V** (não ligue 5 V num pino de GPIO).

| Pino | Função |
| --- | --- |
| KEY A / **G2** | Botão amarelo da frente (caminho ChatGPT) |
| KEY B / **G1** | Botão lateral (caminho Grok Bot) |
| **G3–G8** | GPIO livres |
| 3V3, 5V, GND | Alimentação |
| **G43 / G44** | UART |
| **G0** | Boot strap (não use como GPIO comum) |
| Demais rótulos internos | TP / AMOLED / MIC / IMU / RTC / SPK |

## Como gravar ou atualizar

Atualização normal (**só o app**, preserva bootloader, tabela de partições, LittleFS com os rostos, e o NVS com brilho/volume/etc.):

No MacBook, com o relógio no USB-C (porta típica `/dev/cu.usbmodem101`; alguns cabos só carregam e não aparecem como serial):

```bash
ESPTOOL="$HOME/Library/Arduino15/packages/m5stack/tools/esptool_py/5.3.0/esptool"
PORT=/dev/cu.usbmodem101
APP=/caminho/para/firmware.bin   # o da SHA 74cffd63… acima

$ESPTOOL --chip esp32s3 --port "$PORT" --baud 1500000 \
  write_flash --flash_size 16MB 0x10000 "$APP"
```

Para **recompilar** no box:

```bash
cd firmware
# ambiente PlatformIO do projeto; env de release:
pio run -e m5stack-stopwatch-release
# produto: .pio/build/m5stack-stopwatch-release/firmware.bin
```

A tabela oficial deste projeto é de **8 MB** (app 2,5 MiB + LittleFS), mesmo o StopWatch tendo 16 MB de flash; os 8 MB de cima ficam sem uso. `--flash_size 16MB` no esptool é o que esta gravacão usou.

Primeira instalação completa (apaga o relógio, inclusive LittleFS) exigiria um `merged.bin` em `0x0` gerado **desta mesma** árvore. O `out-bin/jax-stopwatch-ptbr-merged.bin` é de um build anterior e **não** deve ser usado para “atualizar” o aparelho atual.

## Problemas comuns

| Sintoma | O que checar |
| --- | --- |
| `Sem Wi-Fi. Confira a rede 2.4 GHz.` | Rede de 2,4 GHz no alcance; lista em `config_relay.h` (sem imprimir senhas). Depois de apagar a tela, espere a reconexão |
| `Wi-Fi ok, relay falhou` / `tentando relay n/5` | Internet, relay no ar (`/api/health`). `ssl -76` no log, sozinho, não é falha |
| `A gravacao ficou curta...` | Segure o botão o tempo todo da frase; fale perto (~15 cm) |
| `PSRAM cheia` / `Falta memoria pro audio` | Nesta SHA isso não apareceu nos 15 testes. Se voltar, anote se foi numa resposta muito longa ou com o cache do rosto ainda grande, e evite gravar um binário antigo de `out-bin/` |
| `O rele nao respondeu` / HTTP de erro | Token do dispositivo conferido no servidor (nunca cole o valor no chat); corpo curto do erro no balão |
| Relógio some do Mac na hora de gravar | Outro cabo/porta USB; o Grok Bot aberto no Mac; alguns cabos só alimentam |
| Relógio reinicia sozinho ao mexer em Rede | Foi o toque longo da página Rede (legado). Evite segurar essa tela |
| Acentos vazados (`Voc` em vez de `Você`) | Você não está neste firmware (fonte Latin-1). Confira a SHA |

## Onde estão os segredos (e o que não vai neste texto)

Nada disto deve ir para chat, README, PDF ou exportação: senhas de Wi-Fi, `DEVICE_TOKEN`, chaves de API (OpenAI, xAI, ElevenLabs), URL/chave do webhook da rotina, token de callback, cookies ou números de cartão.

| O quê | Onde vive |
| --- | --- |
| Redes Wi-Fi e token do relógio | `firmware/src/config_relay.h` (gitignore; não commitar) |
| URL pública do relay | `RELAY_URL` no mesmo arquivo (esta instalação: `https://m5-voz-relay.vercel.app/api/voz`) |
| Chaves dos provedores, KV, webhook da rotina | Variáveis de ambiente da Vercel (modelo em `relay/.env.example`) |

O modelo seguro para uma instalação nova é `firmware/src/config_relay.example.h`.

## Licença e créditos

Este repositório é uma adaptação em **português do Brasil** do [Jax StopWatch](https://github.com/BTCUP99/jax-stopwatch) de BTCUP99, que por sua vez parte do [stackchan-pet-fw](https://github.com/Corvelis/stackchan-pet-fw). O código original permanece sob a licença MIT; veja `LICENSE` e `THIRD_PARTY_NOTICES.md`. A personalização pt-BR, o caminho de voz pelo relay na Vercel e este README seguem a mesma licença MIT.
