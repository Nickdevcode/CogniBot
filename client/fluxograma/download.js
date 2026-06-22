(function () {
  'use strict';

  function serializarSvg(svg) {
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    const estilos = `
      text { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .forma { stroke-width: 2; fill: #ffffff; }
      .forma-terminador { stroke: #5b6cff; fill: #eef0ff; }
      .forma-processo { stroke: #2d3142; fill: #ffffff; }
      .forma-decisao { stroke: #f59e0b; fill: #fff8eb; }
      .forma-io { stroke: #10b981; fill: #ecfdf5; }
      .forma-documento { stroke: #8b5cf6; fill: #f5f0ff; }
      .forma-paralelo { stroke: #ec4899; fill: #fdf2f8; }
      .bloco-texto { font-size: 13px; font-weight: 500; fill: #1a1a2e; text-anchor: middle; dominant-baseline: middle; }
      .bloco-texto-bold { font-weight: 700; }
      .bloco-texto-pequeno { font-size: 11px; font-weight: 500; }
      .etapa-titulo { font-size: 14px; font-weight: 700; fill: #5b6cff; text-anchor: start; letter-spacing: 0.05em; text-transform: uppercase; }
      .etapa-subtitulo { font-size: 12px; font-weight: 500; fill: #6b7080; text-anchor: start; }
      .linha-etapa { stroke: #d8dbe4; stroke-width: 1.5; stroke-dasharray: 6 4; }
      .conector { stroke: #2d3142; stroke-width: 2; fill: none; }
      .conector-rotulo { font-size: 11px; font-weight: 600; fill: #2d3142; text-anchor: middle; }
      .conector-rotulo-bg { fill: #ffffff; stroke: #d8dbe4; stroke-width: 1; }
      .fluxo-titulo { font-size: 13px; font-weight: 700; fill: #ffffff; text-anchor: middle; }
      .fluxo-caixa { fill: #2d3142; stroke: none; }
      .resumo-caixa { fill: #fff8eb; stroke: #f59e0b; stroke-width: 2; }
      .resumo-texto { font-size: 13px; font-weight: 600; fill: #1a1a2e; text-anchor: middle; dominant-baseline: middle; }
      .resumo-seta { stroke: #f59e0b; stroke-width: 2.5; fill: none; }
    `;

    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = estilos.trim();

    const defs = clone.querySelector('defs') || clone.insertBefore(
      document.createElementNS('http://www.w3.org/2000/svg', 'defs'),
      clone.firstChild
    );
    defs.appendChild(styleEl);

    const xml = new XMLSerializer().serializeToString(clone);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
  }

  function svgParaCanvas(svg, escala) {
    return new Promise((resolve, reject) => {
      const viewBox = svg.viewBox.baseVal;
      const largura = viewBox.width;
      const altura = viewBox.height;

      const xmlStr = serializarSvg(svg);
      const blob = new Blob([xmlStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = largura * escala;
        canvas.height = altura * escala;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);

        resolve({ canvas, largura, altura });
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  function obterJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
    if (window.jsPDF) return window.jsPDF;
    return null;
  }

  function esperarJsPDF(timeoutMs) {
    return new Promise((resolve, reject) => {
      const inicio = Date.now();
      const checar = () => {
        const lib = obterJsPDF();
        if (lib) {
          resolve(lib);
          return;
        }
        if (Date.now() - inicio > timeoutMs) {
          reject(new Error('A biblioteca jsPDF não carregou (vendor/jspdf.umd.min.js não encontrado).'));
          return;
        }
        setTimeout(checar, 100);
      };
      checar();
    });
  }

  async function gerarPdf(svg) {
    const jsPDF = await esperarJsPDF(8000);

    const { canvas, largura, altura } = await svgParaCanvas(svg, 2);
    const imgData = canvas.toDataURL('image/png', 1.0);

    // Razão de aspecto do fluxograma
    const razaoAspecto = largura / altura;

    // PDF em A4. Como o fluxograma é alto (vertical), uso A4 retrato.
    // Largura A4 = 210mm, altura A4 = 297mm.
    // Vou usar um PDF com formato customizado, mantendo proporção do fluxograma,
    // mas limitado a uma largura razoável para impressão (300mm de largura).
    const larguraPdfMm = 300;
    const alturaPdfMm = larguraPdfMm / razaoAspecto;

    const pdf = new jsPDF({
      orientation: alturaPdfMm > larguraPdfMm ? 'portrait' : 'landscape',
      unit: 'mm',
      format: [larguraPdfMm, alturaPdfMm],
      compress: true
    });

    pdf.addImage(imgData, 'PNG', 0, 0, larguraPdfMm, alturaPdfMm, undefined, 'FAST');

    const nome = (document.title || 'fluxograma')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    pdf.save(`${nome || 'fluxograma'}.pdf`);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-download');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const svg = document.getElementById('svg-fluxograma');
      if (!svg) {
        alert('Fluxograma ainda não foi carregado.');
        return;
      }

      const textoOriginal = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Gerando PDF...';

      try {
        await gerarPdf(svg);
        btn.textContent = 'PDF baixado!';
        setTimeout(() => {
          btn.textContent = textoOriginal;
          btn.disabled = false;
        }, 1500);
      } catch (err) {
        console.error('Erro ao gerar PDF:', err);
        alert('Erro ao gerar o PDF. Tente novamente.');
        btn.textContent = textoOriginal;
        btn.disabled = false;
      }
    });
  });
})();
