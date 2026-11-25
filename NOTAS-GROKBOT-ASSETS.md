# Sobre o repositório Ocean-lhy/Stopwatch-GrokBot

Esse projeto é um firmware ESP-IDF só de animação do personagem Grok Bot
(53 estados, atlas GBZ1 de cerca de 8,39 MiB, 400×400, 16 níveis de cinza, 30 fps).
Não fala, não tem Wi-Fi, não chama o Grok Bot por voz e não substitui o Jax/M5 Voz.

Licença: o repositório não traz um arquivo LICENSE. O README avisa que o nome e
o desenho do personagem Grok Bot pertencem aos respectivos donos, e que o
código em third_party/grokbot veio de https://grokbot.yin.wiki/. Por isso este
firmware em pt-BR NÃO inclui o atlas nem os frames do personagem.

Além disso, o atlas sozinho já é maior que a partição de aplicativo de 2,5 MiB
do Jax (tabela de 8 MiB). O firmware original usa uma partição de 12 MiB em
flash de 16 MiB só para caber a animação.
