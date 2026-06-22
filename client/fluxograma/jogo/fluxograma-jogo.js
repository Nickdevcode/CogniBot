(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LARGURA = 1200;

  function el(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
    }
    return node;
  }

  function quebraTexto(texto, maxCaracteres) {
    const palavras = texto.split(' ');
    const linhas = [];
    let atual = '';
    palavras.forEach((p) => {
      if ((atual + ' ' + p).trim().length > maxCaracteres) {
        if (atual) linhas.push(atual.trim());
        atual = p;
      } else {
        atual = (atual + ' ' + p).trim();
      }
    });
    if (atual) linhas.push(atual);
    return linhas;
  }

  function adicionarTexto(g, x, y, texto, opcoes) {
    const opt = opcoes || {};
    const maxChar = opt.maxChar || 30;
    const linhas = quebraTexto(texto, maxChar);
    const lineHeight = opt.lineHeight || 16;
    const inicioY = y - ((linhas.length - 1) * lineHeight) / 2;
    linhas.forEach((linha, i) => {
      const t = el('text', {
        x: x,
        y: inicioY + i * lineHeight,
        class: opt.class || 'bloco-texto'
      });
      t.textContent = linha;
      g.appendChild(t);
    });
  }

  // ============================================================
  // FORMAS
  // ============================================================

  function terminador(g, cx, cy, largura, altura, texto) {
    const rx = altura / 2;
    g.appendChild(el('rect', {
      x: cx - largura / 2,
      y: cy - altura / 2,
      width: largura,
      height: altura,
      rx: rx,
      ry: rx,
      class: 'forma forma-terminador'
    }));
    adicionarTexto(g, cx, cy, texto, {
      maxChar: Math.floor(largura / 8),
      class: 'bloco-texto bloco-texto-bold'
    });
    return {
      topo: { x: cx, y: cy - altura / 2 },
      base: { x: cx, y: cy + altura / 2 },
      esq:  { x: cx - largura / 2, y: cy },
      dir:  { x: cx + largura / 2, y: cy }
    };
  }

  function processo(g, cx, cy, largura, altura, texto) {
    g.appendChild(el('rect', {
      x: cx - largura / 2,
      y: cy - altura / 2,
      width: largura,
      height: altura,
      class: 'forma forma-processo'
    }));
    adicionarTexto(g, cx, cy, texto, { maxChar: Math.floor(largura / 8) });
    return {
      topo: { x: cx, y: cy - altura / 2 },
      base: { x: cx, y: cy + altura / 2 },
      esq:  { x: cx - largura / 2, y: cy },
      dir:  { x: cx + largura / 2, y: cy }
    };
  }

  function decisao(g, cx, cy, largura, altura, texto) {
    const pontos = [
      cx + ',' + (cy - altura / 2),
      (cx + largura / 2) + ',' + cy,
      cx + ',' + (cy + altura / 2),
      (cx - largura / 2) + ',' + cy
    ].join(' ');
    g.appendChild(el('polygon', {
      points: pontos,
      class: 'forma forma-decisao'
    }));
    adicionarTexto(g, cx, cy, texto, {
      maxChar: Math.floor(largura / 11),
      lineHeight: 15
    });
    return {
      topo: { x: cx, y: cy - altura / 2 },
      base: { x: cx, y: cy + altura / 2 },
      esq:  { x: cx - largura / 2, y: cy },
      dir:  { x: cx + largura / 2, y: cy }
    };
  }

  function dados(g, cx, cy, largura, altura, texto) {
    const inclinacao = 18;
    const pontos = [
      (cx - largura / 2 + inclinacao) + ',' + (cy - altura / 2),
      (cx + largura / 2) + ',' + (cy - altura / 2),
      (cx + largura / 2 - inclinacao) + ',' + (cy + altura / 2),
      (cx - largura / 2) + ',' + (cy + altura / 2)
    ].join(' ');
    g.appendChild(el('polygon', {
      points: pontos,
      class: 'forma forma-io'
    }));
    adicionarTexto(g, cx, cy, texto, { maxChar: Math.floor(largura / 8) });
    return {
      topo: { x: cx, y: cy - altura / 2 },
      base: { x: cx, y: cy + altura / 2 },
      esq:  { x: cx - largura / 2 + inclinacao / 2, y: cy },
      dir:  { x: cx + largura / 2 - inclinacao / 2, y: cy }
    };
  }

  // ============================================================
  // CONECTORES
  // ============================================================

  function setaReta(g, p1, p2, rotulo) {
    g.appendChild(el('line', {
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y - 4,
      class: 'conector',
      'marker-end': 'url(#flecha)'
    }));
    if (rotulo) {
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      desenharRotulo(g, mx, my, rotulo);
    }
  }

  function caminho(g, pontos, comFlecha) {
    let d = `M ${pontos[0].x} ${pontos[0].y}`;
    for (let i = 1; i < pontos.length; i++) {
      d += ` L ${pontos[i].x} ${pontos[i].y}`;
    }
    const attrs = { d: d, class: 'conector' };
    if (comFlecha) attrs['marker-end'] = 'url(#flecha)';
    g.appendChild(el('path', attrs));
  }

  function desenharRotulo(g, x, y, texto) {
    const largura = texto.length * 7 + 14;
    g.appendChild(el('rect', {
      x: x - largura / 2,
      y: y - 11,
      width: largura,
      height: 22,
      rx: 5,
      class: 'conector-rotulo-bg'
    }));
    const t = el('text', {
      x: x,
      y: y + 4,
      class: 'conector-rotulo'
    });
    t.textContent = texto;
    g.appendChild(t);
  }

  function divisorEtapa(g, y, titulo, subtitulo) {
    const xInicio = 50;
    g.appendChild(el('line', {
      x1: xInicio,
      y1: y,
      x2: LARGURA - 50,
      y2: y,
      class: 'linha-etapa'
    }));
    const tTitulo = el('text', {
      x: xInicio,
      y: y - 16,
      class: 'etapa-titulo'
    });
    tTitulo.textContent = titulo;
    g.appendChild(tTitulo);
    if (subtitulo) {
      const tSub = el('text', {
        x: xInicio,
        y: y + 22,
        class: 'etapa-subtitulo'
      });
      tSub.textContent = subtitulo;
      g.appendChild(tSub);
    }
  }

  /**
   * Bloco padrão de DECISÃO com ramificação NÃO (loop) e SIM (segue).
   * - O caminho NÃO sai pela esquerda, vai pro bloco de "continuar",
   *   e volta por cima até a lateral esquerda da decisão.
   * - O caminho SIM sai pela base, segue pra baixo.
   * Retorna a coordenada Y final (onde o próximo bloco deve começar).
   */
  function decisaoComLoop(g, cx, yDecisao, larguraDec, alturaDec, perguntaDecisao, textoNao, yBlocoLoopTopo, yTopoLoopRetorno) {
    const dec = decisao(g, cx, yDecisao, larguraDec, alturaDec, perguntaDecisao);

    // Bloco NÃO à esquerda
    const xNao = cx - 360;
    const yNao = yDecisao + 180;
    const bloco = processo(g, xNao, yNao, 280, 70, textoNao);

    // Seta da decisão (lateral esquerda) → bloco NÃO
    caminho(g, [
      dec.esq,
      { x: xNao, y: dec.esq.y },
      { x: xNao, y: bloco.topo.y - 4 }
    ], true);
    desenharRotulo(g, (dec.esq.x + xNao) / 2, dec.esq.y - 14, 'NÃO');

    // Loop de retorno: bloco NÃO → sobe → por cima → entra na esquerda da decisão
    const yLoopCanal = yTopoLoopRetorno;
    caminho(g, [
      { x: xNao, y: bloco.base.y },
      { x: xNao - 40, y: bloco.base.y },
      { x: xNao - 40, y: yLoopCanal },
      { x: dec.esq.x - 50, y: yLoopCanal },
      { x: dec.esq.x - 50, y: dec.esq.y },
      { x: dec.esq.x - 4, y: dec.esq.y }
    ], true);

    // Rótulo SIM (saída pela base)
    desenharRotulo(g, cx + 32, dec.base.y + 16, 'SIM');

    return { decisao: dec, baseY: Math.max(bloco.base.y, dec.base.y) };
  }

  // ============================================================
  // MONTAGEM DO FLUXOGRAMA — PSYBOT
  // ============================================================

  function montarFluxograma() {
    const svg = el('svg', {
      xmlns: SVG_NS,
      class: 'fluxograma-svg',
      id: 'svg-fluxograma'
    });

    const defs = el('defs');
    const marker = el('marker', {
      id: 'flecha',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse'
    });
    marker.appendChild(el('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      fill: '#2d3142'
    }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    const g = el('g');
    svg.appendChild(g);

    const cx = LARGURA / 2;
    let y = 60;
    const ESP = 130;

    // ──────────────────────────────────────────────────
    // ETAPA 0 — CONCEPÇÃO DO PROJETO
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 0 — Concepção do projeto', 'Definição da proposta e direção artística');
    y += 90;

    const b0a = terminador(g, cx, y, 380, 56, 'Início: concepção do jogo PsyBot');
    y += ESP;

    const b0b = processo(g, cx, y, 460, 70, 'Definição da proposta do jogo: nanorrobô experimental em um corpo humano');
    setaReta(g, b0a.base, b0b.topo);
    y += ESP;

    const b0c = dados(g, cx, y, 460, 70, 'Definição do tema central: medos, traumas e intervenção neural');
    setaReta(g, b0b.base, b0c.topo);
    y += ESP;

    const b0d = processo(g, cx, y, 480, 70, 'Criação do conceito artístico, referências visuais e direção estética');
    setaReta(g, b0c.base, b0d.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 1 — INTRODUÇÃO E INÍCIO DO TRATAMENTO
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 1 — Introdução e início do tratamento', 'Tutorial e entrada no organismo');
    y += 90;

    const b1a = processo(g, cx, y, 460, 64, 'Exibição da cutscene inicial com relatório médico de Pedro');
    setaReta(g, b0d.base, b1a.topo);
    y += ESP;

    const b1b = dados(g, cx, y, 480, 70, 'Diagnóstico: ansiedade severa e recomendação do tratamento experimental');
    setaReta(g, b1a.base, b1b.topo);
    y += ESP;

    const b1c = processo(g, cx, y, 460, 64, 'Ativação do nanorrobô dentro do organismo do paciente');
    setaReta(g, b1b.base, b1c.topo);
    y += ESP;

    const b1d = processo(g, cx, y, 380, 60, 'Entrada no sistema digestório');
    setaReta(g, b1c.base, b1d.topo);
    y += ESP;

    const b1e = processo(g, cx, y, 500, 96,
      'Fase 1 — Tutorial no estômago: movimentação, combate básico e interação');
    setaReta(g, b1d.base, b1e.topo);
    y += ESP + 50;

    // Decisão: aprendeu mecânicas?
    const yLoop1 = b1e.base.y + 20;
    const ramif1 = decisaoComLoop(
      g, cx, y, 420, 130,
      'Jogador aprendeu as mecânicas básicas?',
      'Continuar tutorial',
      0, yLoop1
    );
    y = ramif1.baseY + 80;

    const b1g = processo(g, cx, y, 460, 70, 'Transporte pelo sistema circulatório até o cérebro');
    setaReta(g, { x: cx, y: ramif1.decisao.base.y }, b1g.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 2 — FASE 2: MEDO DO ESCURO
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 2 — Fase 2: Medo do escuro', 'Casa durante tempestade');
    y += 90;

    const b2a = processo(g, cx, y, 480, 70, 'Entrada na sala de descanso e evolução do personagem');
    setaReta(g, b1g.base, b2a.topo);
    y += ESP;

    const b2b = dados(g, cx, y, 420, 60, 'Ambiente inicialmente caótico e instável');
    setaReta(g, b2a.base, b2b.topo);
    y += ESP;

    const b2c = processo(g, cx, y, 540, 96,
      'Início da exploração da fase 2: casa durante tempestade, baixa iluminação e sons de trovões');
    setaReta(g, b2b.base, b2c.topo);
    y += ESP + 30;

    const b2d = processo(g, cx, y, 460, 70, 'Exploração do cenário com visibilidade reduzida');
    setaReta(g, b2c.base, b2d.topo);
    y += ESP + 50;

    // Decisão: encontrou área do chefe?
    const yLoop2a = b2d.base.y + 20;
    const ramif2a = decisaoComLoop(
      g, cx, y, 420, 130,
      'Jogador encontrou a área do chefe?',
      'Continuar exploração',
      0, yLoop2a
    );
    y = ramif2a.baseY + 80;

    const b2f = processo(g, cx, y, 380, 60, 'Início do combate contra o chefe');
    setaReta(g, { x: cx, y: ramif2a.decisao.base.y }, b2f.topo);
    y += ESP;

    const b2g = processo(g, cx, y, 480, 70, 'Relâmpagos iluminam o cenário temporariamente');
    setaReta(g, b2f.base, b2g.topo);
    y += ESP + 50;

    // Decisão: chefe exposto à iluminação?
    const yLoop2b = b2g.base.y + 20;
    const ramif2b = decisaoComLoop(
      g, cx, y, 420, 130,
      'Chefe exposto à iluminação?',
      'Jogador evita ataques',
      0, yLoop2b
    );
    y = ramif2b.baseY + 80;

    const b2i = processo(g, cx, y, 420, 60, 'Chefe vulnerável momentaneamente');
    setaReta(g, { x: cx, y: ramif2b.decisao.base.y }, b2i.topo);
    y += ESP + 50;

    // Decisão: chefe derrotado?
    const yLoop2c = b2i.base.y + 20;
    const ramif2c = decisaoComLoop(
      g, cx, y, 360, 120,
      'Chefe derrotado?',
      'Continuação do combate',
      0, yLoop2c
    );
    y = ramif2c.baseY + 80;

    const b2k = processo(g, cx, y, 460, 70, 'Estabilização parcial da sala de descanso');
    setaReta(g, { x: cx, y: ramif2c.decisao.base.y }, b2k.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 3 — FASE 3: MEDO DO FRACASSO
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 3 — Fase 3: Medo do fracasso', 'Perfeição idealizada e colapso');
    y += 90;

    const b3a = processo(g, cx, y, 320, 60, 'Entrada na fase 3');
    setaReta(g, b2k.base, b3a.topo);
    y += ESP;

    const b3b = dados(g, cx, y, 520, 70, 'Cenário degradado representando a percepção distorcida de futuro');
    setaReta(g, b3a.base, b3b.topo);
    y += ESP;

    const b3c = processo(g, cx, y, 380, 60, 'Exploração da rua instável');
    setaReta(g, b3b.base, b3c.topo);
    y += ESP;

    const b3d = processo(g, cx, y, 480, 70, 'Fragmentação constante do cenário e colapso estrutural');
    setaReta(g, b3c.base, b3d.topo);
    y += ESP + 50;

    // Decisão: alcançou a área do chefe?
    const yLoop3a = b3d.base.y + 20;
    const ramif3a = decisaoComLoop(
      g, cx, y, 420, 130,
      'Jogador alcançou a área do chefe?',
      'Continuar exploração',
      0, yLoop3a
    );
    y = ramif3a.baseY + 80;

    const b3f = processo(g, cx, y, 520, 70, 'Início do combate contra a entidade da perfeição idealizada');
    setaReta(g, { x: cx, y: ramif3a.decisao.base.y }, b3f.topo);
    y += ESP;

    const b3g = processo(g, cx, y, 540, 80, 'Primeira forma: aparência impecável e ambiente relativamente estável');
    setaReta(g, b3f.base, b3g.topo);
    y += ESP + 50;

    // Decisão: primeira forma derrotada?
    const yLoop3b = b3g.base.y + 20;
    const ramif3b = decisaoComLoop(
      g, cx, y, 420, 130,
      'Primeira forma derrotada?',
      'Continuação do combate',
      0, yLoop3b
    );
    y = ramif3b.baseY + 80;

    const b3i = processo(g, cx, y, 440, 64, 'Transformação para forma distorcida');
    setaReta(g, { x: cx, y: ramif3b.decisao.base.y }, b3i.topo);
    y += ESP;

    const b3j = processo(g, cx, y, 460, 64, 'Intensificação do colapso do cenário');
    setaReta(g, b3i.base, b3j.topo);
    y += ESP + 50;

    // Decisão: chefe derrotado?
    const yLoop3c = b3j.base.y + 20;
    const ramif3c = decisaoComLoop(
      g, cx, y, 360, 120,
      'Chefe derrotado?',
      'Continuação do combate',
      0, yLoop3c
    );
    y = ramif3c.baseY + 80;

    const b3l = processo(g, cx, y, 460, 70, 'Sala de descanso torna-se mais estável');
    setaReta(g, { x: cx, y: ramif3c.decisao.base.y }, b3l.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 4 — FASE 4: LUTO
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 4 — Fase 4: Luto', 'Apego, perda e desfecho');
    y += 90;

    const b4a = processo(g, cx, y, 380, 60, 'Entrada na fase final');
    setaReta(g, b3l.base, b4a.topo);
    y += ESP;

    const b4b = dados(g, cx, y, 380, 60, 'Ambiente silencioso e vazio');
    setaReta(g, b4a.base, b4b.topo);
    y += ESP;

    const b4c = processo(g, cx, y, 380, 60, 'Exploração do cemitério');
    setaReta(g, b4b.base, b4c.topo);
    y += ESP;

    const b4d = processo(g, cx, y, 480, 70, 'Transformação gradual do cenário em uma casa vazia');
    setaReta(g, b4c.base, b4d.topo);
    y += ESP;

    const b4e = processo(g, cx, y, 500, 76, 'Ausência de inimigos comuns para enfatizar isolamento');
    setaReta(g, b4d.base, b4e.topo);
    y += ESP;

    const b4f = processo(g, cx, y, 500, 80, 'Encontro com a entidade final ligada ao apego e à perda');
    setaReta(g, b4e.base, b4f.topo);
    y += ESP + 50;

    // Decisão final: chefe derrotado?
    const yLoop4 = b4f.base.y + 20;
    const ramif4 = decisaoComLoop(
      g, cx, y, 360, 120,
      'Chefe derrotado?',
      'Continuação do combate',
      0, yLoop4
    );
    y = ramif4.baseY + 80;

    const b4h = processo(g, cx, y, 460, 70, 'Estabilização do ambiente mental de Pedro');
    setaReta(g, { x: cx, y: ramif4.decisao.base.y }, b4h.topo);
    y += ESP;

    const b4i = terminador(g, cx, y, 320, 56, 'Final do jogo');
    setaReta(g, b4h.base, b4i.topo);
    y += 100;

    // ViewBox final
    svg.setAttribute('viewBox', `0 0 ${LARGURA} ${y}`);
    svg.setAttribute('width', LARGURA);
    svg.setAttribute('height', y);

    return svg;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const area = document.getElementById('fluxograma-area');
    if (!area) return;
    const svg = montarFluxograma();
    area.appendChild(svg);
  });
})();
