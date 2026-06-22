(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LARGURA = 1400;

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
  // FORMAS — cada uma retorna { topo, base, esq, dir } com coords
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

  function entradaSaida(g, cx, cy, largura, altura, texto) {
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

  function documento(g, cx, cy, largura, altura, texto) {
    const x1 = cx - largura / 2;
    const x2 = cx + largura / 2;
    const y1 = cy - altura / 2;
    const y2 = cy + altura / 2 - 8;
    const onda = 12;

    const d = [
      'M', x1, y1,
      'L', x2, y1,
      'L', x2, y2,
      'Q', (cx + largura / 4), y2 + onda, cx, y2,
      'Q', (cx - largura / 4), y2 - onda, x1, y2,
      'Z'
    ].join(' ');

    g.appendChild(el('path', {
      d: d,
      class: 'forma forma-documento'
    }));
    adicionarTexto(g, cx, cy - 6, texto, { maxChar: Math.floor(largura / 8) });
    return {
      topo: { x: cx, y: y1 },
      base: { x: cx, y: cy + altura / 2 + 4 },
      esq:  { x: x1, y: cy },
      dir:  { x: x2, y: cy }
    };
  }

  function barraParalela(g, cx, cy, largura, texto) {
    const altura = 12;
    g.appendChild(el('rect', {
      x: cx - largura / 2,
      y: cy - altura / 2,
      width: largura,
      height: altura,
      class: 'forma forma-paralelo'
    }));
    if (texto) {
      const t = el('text', {
        x: cx,
        y: cy - altura / 2 - 10,
        class: 'bloco-texto bloco-texto-pequeno',
        'text-anchor': 'middle'
      });
      t.textContent = texto;
      g.appendChild(t);
    }
    return {
      topo: { x: cx, y: cy - altura / 2 },
      base: { x: cx, y: cy + altura / 2 }
    };
  }

  // ============================================================
  // CONECTORES
  // ============================================================

  function setaReta(g, p1, p2, rotulo) {
    const linha = el('line', {
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y - 4,
      class: 'conector',
      'marker-end': 'url(#flecha)'
    });
    g.appendChild(linha);

    if (rotulo) {
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      desenharRotulo(g, mx, my, rotulo);
    }
  }

  function setaCotovelo(g, p1, p2, opcoes) {
    const opt = opcoes || {};
    const yMeio = opt.yMeio != null ? opt.yMeio : (p1.y + p2.y) / 2;
    const d = `M ${p1.x} ${p1.y} L ${p1.x} ${yMeio} L ${p2.x} ${yMeio} L ${p2.x} ${p2.y - 4}`;
    g.appendChild(el('path', {
      d: d,
      class: 'conector',
      'marker-end': 'url(#flecha)'
    }));
  }

  function linhaSimples(g, p1, p2) {
    g.appendChild(el('line', {
      x1: p1.x, y1: p1.y,
      x2: p2.x, y2: p2.y,
      class: 'conector'
    }));
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

  function fluxoCabecalho(g, cx, y, largura, texto) {
    g.appendChild(el('rect', {
      x: cx - largura / 2,
      y: y - 18,
      width: largura,
      height: 36,
      rx: 8,
      class: 'fluxo-caixa'
    }));
    const t = el('text', {
      x: cx,
      y: y + 6,
      class: 'fluxo-titulo'
    });
    t.textContent = texto;
    g.appendChild(t);
    return { base: { x: cx, y: y + 18 } };
  }

  // ============================================================
  // MONTAGEM DO FLUXOGRAMA
  // ============================================================

  function montarFluxograma() {
    const svg = el('svg', {
      xmlns: SVG_NS,
      class: 'fluxograma-svg',
      id: 'svg-fluxograma'
    });

    // Definições (marcadores de flecha)
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

    const markerLaranja = el('marker', {
      id: 'flecha-laranja',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse'
    });
    markerLaranja.appendChild(el('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      fill: '#f59e0b'
    }));
    defs.appendChild(markerLaranja);
    svg.appendChild(defs);

    const g = el('g');
    svg.appendChild(g);

    const cx = LARGURA / 2;
    let y = 60;

    // Espaçamento entre blocos (de centro a centro)
    const ESP = 130;

    // ──────────────────────────────────────────────────
    // ETAPA 0
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 0 — Ponto de partida', 'Concepção e definição do escopo do TCC');
    y += 90;

    const b0a = terminador(g, cx, y, 360, 56, 'Início: concepção do projeto Cogni');
    y += ESP;

    const b0b = processo(g, cx, y, 460, 72, 'Definição da proposta do TCC: tutora educacional com IA e robô físico');
    setaReta(g, b0a.base, b0b.topo);
    y += ESP;

    const b0c = documento(g, cx, y, 400, 80, 'Documento de visão geral e escopo do projeto');
    setaReta(g, b0b.base, b0c.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 1
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 1 — Desenvolvimento do cérebro da Cogni', 'Em andamento — servidor central de IA');
    y += 90;

    const b1a = processo(g, cx, y, 460, 64, 'Construção do servidor central — o "cérebro" da Cogni');
    setaReta(g, b0c.base, b1a.topo);
    y += ESP - 10;

    // Barra de início paralelo
    const yBarraIni1 = y;
    barraParalela(g, cx, yBarraIni1, 760, 'Início de etapas simultâneas');
    linhaSimples(g, b1a.base, { x: cx, y: yBarraIni1 - 6 });
    y += 90;

    // Dois ramos paralelos
    const xEsq = cx - 290;
    const xDir = cx + 290;

    const ramo1Esq = processo(g, xEsq, y, 400, 80, 'Pipeline de conversa: ouvir, entender e responder com voz');
    const ramo1Dir = processo(g, xDir, y, 400, 80, 'Camada de segurança: proteção de dados, filtros e privacidade');

    // Distribuição da barra para os ramos
    caminho(g, [
      { x: cx, y: yBarraIni1 + 6 },
      { x: cx, y: y - 60 },
      { x: xEsq, y: y - 60 },
      { x: xEsq, y: ramo1Esq.topo.y - 4 }
    ], true);
    caminho(g, [
      { x: cx, y: yBarraIni1 + 6 },
      { x: cx, y: y - 60 },
      { x: xDir, y: y - 60 },
      { x: xDir, y: ramo1Dir.topo.y - 4 }
    ], true);

    y += 110;

    // Barra de fim paralelo
    const yBarraFim1 = y;
    barraParalela(g, cx, yBarraFim1, 760, 'Fim das etapas simultâneas');
    caminho(g, [
      { x: xEsq, y: ramo1Esq.base.y },
      { x: xEsq, y: yBarraFim1 - 6 },
      { x: cx, y: yBarraFim1 - 6 }
    ], false);
    caminho(g, [
      { x: xDir, y: ramo1Dir.base.y },
      { x: xDir, y: yBarraFim1 - 6 },
      { x: cx, y: yBarraFim1 - 6 }
    ], false);

    y += 100;

    const b1c = processo(g, cx, y, 480, 76, 'Memória personalizada por usuário (a Cogni lembra de cada criança)');
    setaReta(g, { x: cx, y: yBarraFim1 + 6 }, b1c.topo);
    y += ESP + 5;

    const b1d = processo(g, cx, y, 540, 80, 'Visão por câmera e pesquisa na internet quando precisa de contexto extra');
    setaReta(g, b1c.base, b1d.topo);
    y += ESP + 5;

    const b1e = documento(g, cx, y, 400, 80, 'Cérebro funcional, pronto para conversar');
    setaReta(g, b1d.base, b1e.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 2
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 2 — Interface da criança', 'A "tela" da Cogni');
    y += 90;

    const b2a = processo(g, cx, y, 460, 64, 'Construção da interface por onde a criança fala e vê a Cogni');
    setaReta(g, b1e.base, b2a.topo);
    y += ESP - 10;

    const yBarraIni2 = y;
    barraParalela(g, cx, yBarraIni2, 720, 'Início de etapas simultâneas');
    linhaSimples(g, b2a.base, { x: cx, y: yBarraIni2 - 6 });
    y += 90;

    const ramo2Esq = processo(g, xEsq, y, 400, 80, 'Conversa por voz com detecção automática de fala');
    const ramo2Dir = processo(g, xDir, y, 400, 80, 'Visual amigável, acessível e responsivo');

    caminho(g, [
      { x: cx, y: yBarraIni2 + 6 },
      { x: cx, y: y - 60 },
      { x: xEsq, y: y - 60 },
      { x: xEsq, y: ramo2Esq.topo.y - 4 }
    ], true);
    caminho(g, [
      { x: cx, y: yBarraIni2 + 6 },
      { x: cx, y: y - 60 },
      { x: xDir, y: y - 60 },
      { x: xDir, y: ramo2Dir.topo.y - 4 }
    ], true);

    y += 110;

    const yBarraFim2 = y;
    barraParalela(g, cx, yBarraFim2, 720, 'Fim das etapas simultâneas');
    caminho(g, [
      { x: xEsq, y: ramo2Esq.base.y },
      { x: xEsq, y: yBarraFim2 - 6 },
      { x: cx, y: yBarraFim2 - 6 }
    ], false);
    caminho(g, [
      { x: xDir, y: ramo2Dir.base.y },
      { x: xDir, y: yBarraFim2 - 6 },
      { x: cx, y: yBarraFim2 - 6 }
    ], false);

    y += 100;

    const b2c = documento(g, cx, y, 380, 80, 'Experiência da criança pronta');
    setaReta(g, { x: cx, y: yBarraFim2 + 6 }, b2c.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 3
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 3 — Robô físico', 'Corpo da Cogni');
    y += 90;

    const b3a = processo(g, cx, y, 520, 80, 'Montagem do robô físico: estrutura, movimento, alto-falante e câmera');
    setaReta(g, b2c.base, b3a.topo);
    y += ESP + 5;

    const b3b = processo(g, cx, y, 520, 80, 'Conexão do robô ao cérebro da Cogni (comunicação em tempo real)');
    setaReta(g, b3a.base, b3b.topo);
    y += ESP + 30;

    const b3d = decisao(g, cx, y, 400, 120, 'O robô recebe áudio e comandos corretamente?');
    setaReta(g, b3b.base, b3d.topo);
    y += 160;

    // Caminho NÃO (esquerda → ajuste → retorno por cima)
    const xAjusteRobo = cx - 380;
    const b3eNao = processo(g, xAjusteRobo, y, 280, 80, 'Ajustes de comunicação e firmware');

    // Decisão → ajuste (saída pela esquerda)
    caminho(g, [
      b3d.esq,
      { x: xAjusteRobo, y: b3d.esq.y },
      { x: xAjusteRobo, y: b3eNao.topo.y - 4 }
    ], true);
    desenharRotulo(g, (b3d.esq.x + xAjusteRobo) / 2, b3d.esq.y - 14, 'NÃO');

    // Caminho SIM (direita)
    const xSimRobo = cx + 380;
    const b3eSim = processo(g, xSimRobo, y, 280, 80, 'Robô responde, fala e enxerga em tempo real');

    caminho(g, [
      b3d.dir,
      { x: xSimRobo, y: b3d.dir.y },
      { x: xSimRobo, y: b3eSim.topo.y - 4 }
    ], true);
    desenharRotulo(g, (b3d.dir.x + xSimRobo) / 2, b3d.dir.y - 14, 'SIM');

    // Loop de retorno do "NÃO" para a decisão (por cima, pela esquerda)
    const yLoopTopo = b3b.base.y + 18;
    caminho(g, [
      { x: xAjusteRobo, y: b3eNao.topo.y - 4 },
      { x: xAjusteRobo, y: yLoopTopo },
      { x: b3d.esq.x - 50, y: yLoopTopo },
      { x: b3d.esq.x - 50, y: b3d.esq.y },
      { x: b3d.esq.x - 4, y: b3d.esq.y }
    ], true);

    y += ESP + 30;

    // Convergência só do SIM para o documento (NÃO já voltou no loop)
    const b3f = documento(g, cx, y, 380, 80, 'Robô integrado ao cérebro');
    caminho(g, [
      b3eSim.base,
      { x: xSimRobo, y: b3f.topo.y - 30 },
      { x: cx, y: b3f.topo.y - 30 },
      { x: cx, y: b3f.topo.y - 4 }
    ], true);

    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 4
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 4 — Aplicativo dos pais', 'Cogni Companion');
    y += 90;

    const b4a = processo(g, cx, y, 420, 60, 'Planejamento do Companion com base no MDA');
    setaReta(g, b3f.base, b4a.topo);
    y += ESP;

    const b4b = processo(g, cx, y, 420, 60, 'Definição das telas principais');
    setaReta(g, b4a.base, b4b.topo);
    y += ESP - 10;

    const yBarraIni3 = y;
    barraParalela(g, cx, yBarraIni3, 900, 'Início de etapas simultâneas');
    linhaSimples(g, b4b.base, { x: cx, y: yBarraIni3 - 6 });
    y += 100;

    // Três ramos
    const xRamo1 = cx - 360;
    const xRamo2 = cx;
    const xRamo3 = cx + 360;

    const ramo4a = processo(g, xRamo1, y, 280, 60, 'Diário de conversas');
    const ramo4b = processo(g, xRamo2, y, 280, 60, 'Painel de aprendizado');
    const ramo4c = processo(g, xRamo3, y, 280, 60, 'Construtor de planos de estudo');

    caminho(g, [
      { x: cx, y: yBarraIni3 + 6 },
      { x: cx, y: y - 60 },
      { x: xRamo1, y: y - 60 },
      { x: xRamo1, y: ramo4a.topo.y - 4 }
    ], true);
    caminho(g, [
      { x: cx, y: yBarraIni3 + 6 },
      { x: xRamo2, y: ramo4b.topo.y - 4 }
    ], true);
    caminho(g, [
      { x: cx, y: yBarraIni3 + 6 },
      { x: cx, y: y - 60 },
      { x: xRamo3, y: y - 60 },
      { x: xRamo3, y: ramo4c.topo.y - 4 }
    ], true);

    y += 110;

    const yBarraFim3 = y;
    barraParalela(g, cx, yBarraFim3, 900, 'Fim das etapas simultâneas');
    caminho(g, [
      { x: xRamo1, y: ramo4a.base.y },
      { x: xRamo1, y: yBarraFim3 - 6 },
      { x: cx, y: yBarraFim3 - 6 }
    ], false);
    caminho(g, [
      { x: xRamo2, y: ramo4b.base.y },
      { x: xRamo2, y: yBarraFim3 - 6 }
    ], false);
    caminho(g, [
      { x: xRamo3, y: ramo4c.base.y },
      { x: xRamo3, y: yBarraFim3 - 6 },
      { x: cx, y: yBarraFim3 - 6 }
    ], false);

    y += 100;

    const b4d = processo(g, cx, y, 560, 80, 'Recursos complementares: resumo semanal, conquistas e perfis da família');
    setaReta(g, { x: cx, y: yBarraFim3 + 6 }, b4d.topo);
    y += ESP + 5;

    const b4e = processo(g, cx, y, 520, 80, 'Camada de privacidade reforçada (foco em proteção de dados de crianças)');
    setaReta(g, b4d.base, b4e.topo);
    y += ESP + 5;

    const b4f = documento(g, cx, y, 420, 80, 'Aplicativo Companion pronto para conectar');
    setaReta(g, b4e.base, b4f.topo);
    y += ESP + 10;

    // ──────────────────────────────────────────────────
    // ETAPA 5
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 5 — Integração entre Cogni e Companion', 'Fluxos bidirecionais de dados');
    y += 90;

    const b5a = processo(g, cx, y, 540, 64, 'Conectar o aplicativo dos pais ao cérebro da Cogni');
    setaReta(g, b4f.base, b5a.topo);
    y += ESP + 40;

    // Dois fluxos lado a lado
    const xFluxoA = cx - 340;
    const xFluxoB = cx + 340;

    const cabA = fluxoCabecalho(g, xFluxoA, y, 580, 'FLUXO A — Da criança para os pais');
    const cabB = fluxoCabecalho(g, xFluxoB, y, 580, 'FLUXO B — Dos pais para a criança');

    // Distribuir do b5a para os dois cabeçalhos
    caminho(g, [
      b5a.base,
      { x: cx, y: y - 50 },
      { x: xFluxoA, y: y - 50 },
      { x: xFluxoA, y: y - 22 }
    ], true);
    caminho(g, [
      b5a.base,
      { x: cx, y: y - 50 },
      { x: xFluxoB, y: y - 50 },
      { x: xFluxoB, y: y - 22 }
    ], true);

    y += 90;

    // Fluxo A — 4 blocos / Fluxo B — 4 blocos
    const f1A = entradaSaida(g, xFluxoA, y, 380, 64, 'Criança fala com o robô');
    const f1B = entradaSaida(g, xFluxoB, y, 380, 64, 'Pais criam plano de estudo no app');
    setaReta(g, cabA.base, f1A.topo);
    setaReta(g, cabB.base, f1B.topo);
    y += ESP + 5;

    const f2A = processo(g, xFluxoA, y, 380, 64, 'A Cogni processa a conversa');
    const f2B = processo(g, xFluxoB, y, 380, 64, 'O plano é enviado ao cérebro da Cogni');
    setaReta(g, f1A.base, f2A.topo);
    setaReta(g, f1B.base, f2B.topo);
    y += ESP + 5;

    const f3A = processo(g, xFluxoA, y, 420, 80, 'O cérebro registra transcrição, matéria estudada e curiosidades');
    const f3B = processo(g, xFluxoB, y, 420, 80, 'A Cogni adapta o roteiro da próxima conversa');
    setaReta(g, f2A.base, f3A.topo);
    setaReta(g, f2B.base, f3B.topo);
    y += ESP + 10;

    const f4A = entradaSaida(g, xFluxoA, y, 420, 80, 'Companion exibe em tempo real para os pais');
    const f4B = entradaSaida(g, xFluxoB, y, 420, 80, 'A criança chega no robô e a Cogni já puxa assunto');
    setaReta(g, f3A.base, f4A.topo);
    setaReta(g, f3B.base, f4B.topo);
    y += ESP + 50;

    // Convergir os dois fluxos antes da etapa 6
    const yConvergencia = y - 20;
    caminho(g, [
      f4A.base,
      { x: xFluxoA, y: yConvergencia },
      { x: cx, y: yConvergencia }
    ], false);
    caminho(g, [
      f4B.base,
      { x: xFluxoB, y: yConvergencia },
      { x: cx, y: yConvergencia }
    ], false);

    // ──────────────────────────────────────────────────
    // ETAPA 6
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 6 — Testes, ajustes e validação', 'Integração completa em uso real');
    // continuidade da convergência para o próximo bloco
    y += 90;

    const b6a = processo(g, cx, y, 520, 80, 'Testes de uso real: criança, robô, pais e aplicativo juntos');
    caminho(g, [
      { x: cx, y: yConvergencia },
      { x: cx, y: b6a.topo.y - 4 }
    ], true);
    y += ESP + 30;

    const b6b = decisao(g, cx, y, 420, 120, 'Tudo funciona de forma fluida e segura?');
    setaReta(g, b6a.base, b6b.topo);
    y += 160;

    // NÃO (esquerda)
    const xAjuste6 = cx - 380;
    const b6Nao = processo(g, xAjuste6, y, 280, 80, 'Ajustes finos e correções');
    caminho(g, [
      b6b.esq,
      { x: xAjuste6, y: b6b.esq.y },
      { x: xAjuste6, y: b6Nao.topo.y - 4 }
    ], true);
    desenharRotulo(g, (b6b.esq.x + xAjuste6) / 2, b6b.esq.y - 14, 'NÃO');

    // SIM (direita)
    const xSim6 = cx + 380;
    const b6Sim = processo(g, xSim6, y, 280, 80, 'Validação do conjunto completo');
    caminho(g, [
      b6b.dir,
      { x: xSim6, y: b6b.dir.y },
      { x: xSim6, y: b6Sim.topo.y - 4 }
    ], true);
    desenharRotulo(g, (b6b.dir.x + xSim6) / 2, b6b.dir.y - 14, 'SIM');

    // Loop do NÃO de volta para os testes
    const yLoop6 = b6a.base.y + 25;
    caminho(g, [
      { x: xAjuste6, y: b6Nao.topo.y - 4 },
      { x: xAjuste6, y: yLoop6 },
      { x: b6b.esq.x - 50, y: yLoop6 },
      { x: b6b.esq.x - 50, y: b6b.esq.y },
      { x: b6b.esq.x - 4, y: b6b.esq.y }
    ], true);

    y += ESP + 30;

    // ──────────────────────────────────────────────────
    // ETAPA 7
    // ──────────────────────────────────────────────────
    divisorEtapa(g, y, 'Etapa 7 — Entrega final', 'Documentação e apresentação do TCC');
    y += 90;

    const b7a = processo(g, cx, y, 440, 60, 'Documentação do projeto e do MDA');
    // SIM conecta no b7a
    caminho(g, [
      b6Sim.base,
      { x: xSim6, y: b7a.topo.y - 30 },
      { x: cx, y: b7a.topo.y - 30 },
      { x: cx, y: b7a.topo.y - 4 }
    ], true);
    y += ESP;

    const b7b = processo(g, cx, y, 380, 60, 'Apresentação do TCC');
    setaReta(g, b7a.base, b7b.topo);
    y += ESP;

    const b7c = terminador(g, cx, y, 580, 64, 'Fim: Cogni e Companion entregues como ecossistema completo');
    setaReta(g, b7b.base, b7c.topo);
    y += 100;

    // ──────────────────────────────────────────────────
    // RESUMO VISUAL DA INTEGRAÇÃO
    // ──────────────────────────────────────────────────
    y += 30;
    g.appendChild(el('line', {
      x1: 50,
      y1: y,
      x2: LARGURA - 50,
      y2: y,
      class: 'linha-etapa'
    }));
    const tResumo = el('text', {
      x: 50,
      y: y - 16,
      class: 'etapa-titulo'
    });
    tResumo.textContent = 'Resumo visual da integração';
    g.appendChild(tResumo);
    y += 80;

    const itens = ['Criança', 'Robô', 'Cogni', 'Companion', 'Pais'];
    const larguraCaixa = 150;
    const espacoCaixa = 230;
    const inicioX = cx - ((itens.length - 1) * espacoCaixa) / 2;

    const centrosX = [];
    itens.forEach((nome, i) => {
      const x = inicioX + i * espacoCaixa;
      centrosX.push(x);
      g.appendChild(el('rect', {
        x: x - larguraCaixa / 2,
        y: y - 28,
        width: larguraCaixa,
        height: 56,
        rx: 12,
        class: 'resumo-caixa'
      }));
      const t = el('text', {
        x: x,
        y: y + 5,
        class: 'resumo-texto'
      });
      t.textContent = nome;
      g.appendChild(t);
    });

    // Setas entre as caixas (esquerda → direita)
    for (let i = 0; i < itens.length - 1; i++) {
      const xIni = centrosX[i] + larguraCaixa / 2 + 2;
      const xFim = centrosX[i + 1] - larguraCaixa / 2 - 6;
      g.appendChild(el('line', {
        x1: xIni,
        y1: y,
        x2: xFim,
        y2: y,
        class: 'resumo-seta',
        'marker-end': 'url(#flecha-laranja)'
      }));
    }

    // Arco "Plano de estudo": Companion (índice 3) → Robô (índice 1)
    const xRoboResumo = centrosX[1];
    const xCompResumo = centrosX[3];
    const yArco = y + 80;

    caminho(g, [
      { x: xCompResumo, y: y + 28 },
      { x: xCompResumo, y: yArco },
      { x: xRoboResumo, y: yArco },
      { x: xRoboResumo, y: y + 32 }
    ], false);
    // Substituir cor do último caminho desenhado para laranja
    const ultimosPaths = g.querySelectorAll('path.conector');
    const ultimo = ultimosPaths[ultimosPaths.length - 1];
    if (ultimo) {
      ultimo.setAttribute('class', 'resumo-seta');
      ultimo.setAttribute('marker-end', 'url(#flecha-laranja)');
    }

    // Rótulo "Plano de estudo"
    const xMeioArco = (xRoboResumo + xCompResumo) / 2;
    const textoPlano = 'Plano de estudo';
    const larguraRot = textoPlano.length * 7 + 16;
    g.appendChild(el('rect', {
      x: xMeioArco - larguraRot / 2,
      y: yArco - 11,
      width: larguraRot,
      height: 22,
      rx: 5,
      class: 'conector-rotulo-bg'
    }));
    const tPlano = el('text', {
      x: xMeioArco,
      y: yArco + 4,
      class: 'conector-rotulo'
    });
    tPlano.textContent = textoPlano;
    g.appendChild(tPlano);

    y += 140;

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
