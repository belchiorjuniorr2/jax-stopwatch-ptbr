# Jax StopWatch em português (pt-BR)

Tradução da interface, da voz e do painel do Mac para português do Brasil.
O firmware e o aplicativo no Mac precisam desta árvore, não do Jax original em chinês.

## O que o Jax precisa para funcionar

O relógio **não funciona sozinho**. O cérebro fica no Mac (Apple silicon):

1. Um Mac com chip Apple (o reconhecimento de voz usa MLX / Whisper).
2. Python via `uv`, depois `scripts/setup.sh` (baixa o modelo Whisper, cerca de 500 MB).
3. A ponte no Mac: `scripts/start.command` — painel em http://127.0.0.1:18765
4. Firmware Jax gravado no StopWatch.
5. Wi-Fi e chaves: **não vão no código**. Emparelhe com o relógio no USB, no painel, em “Rede sem fio”. Dá para gravar até 4 redes (casa e hotspot 2,4 GHz do celular).
6. Assistentes (opcional, no painel):
   - Codex: login do ChatGPT já existente no Mac (`codex app-server`).
   - Grok Bot: URL e chave de um webhook de rotina.
7. Fora de casa: hotspot 2,4 GHz do celular **e** Tailscale Funnel na porta 8443, **com o Mac ligado e a ponte rodando**.
8. Voz: o Mac precisa da voz **Luciana** (pt-BR) em Ajustes > Acessibilidade > Conteúdo falado. Se não estiver instalada, o painel avisa.
9. Despertar pelo nome (opcional): o nome padrão é **Jax**.

Segredos ficam em `runtime/` (ignorado pelo git). Não coloque senha de Wi-Fi, token ou chave no chat.

## Como gravar (quando o desenho no Mac terminar)

Não grave enquanto outro trabalho estiver usando o mouse ou o Chrome no Mac.
O relógio costuma aparecer em `/dev/cu.usbmodem101`.

Primeira gravação (apaga tudo; faça backup antes):

```sh
# no Mac, com o relógio no USB e o modo de gravação ativo
ESPTOOL="$HOME/Library/Arduino15/packages/m5stack/tools/esptool_py/5.3.0/esptool"
PORT=/dev/cu.usbmodem101
$ESPTOOL --chip esp32s3 --port $PORT --baud 921600 write-flash 0x0 out-bin/jax-stopwatch-ptbr-merged.bin
```

Só o aplicativo (preserva Wi-Fi e imagens já gravados, se a tabela de partições for a mesma):

```sh
$ESPTOOL --chip esp32s3 --port $PORT --baud 921600 write-flash 0x10000 out-bin/jax-stopwatch-ptbr-app.bin
```

Ou, no projeto, `scripts/flash.sh --first-install out-bin/jax-stopwatch-ptbr-app.bin` (primeira vez) e `scripts/flash.sh out-bin/jax-stopwatch-ptbr-app.bin` (atualização).
