// Client-side script for the solar report
// This gets bundled with esbuild and inlined into the HTML

import * as vega from 'vega';
import * as vegaLite from 'vega-lite';

declare global {
  interface Window {
    REPORT_CHARTS: Record<string, object | undefined>;
    initReport: () => void;
    renderPanelCharts: (panelId: string) => void;
  }
}

const chartRendered: Record<string, boolean> = {};

async function renderChart(id: string, spec: object | undefined): Promise<void> {
  if (!spec) return;
  if (chartRendered[id]) return;
  chartRendered[id] = true;

  const container = document.getElementById(id);
  if (!container) return;

  try {
    // Compile Vega-Lite to Vega
    const vegaSpec = vegaLite.compile(spec as vegaLite.TopLevelSpec).spec;

    // Create and render the Vega view
    const view = new vega.View(vega.parse(vegaSpec), {
      renderer: 'svg',
      container: container,
      hover: true
    });

    await view.runAsync();
  } catch (e) {
    console.error('Failed to render chart:', id, e);
  }
}

function animateCountUp(el: HTMLElement): void {
  const target = parseFloat(el.dataset.value || '0');
  const duration = 1500;
  const start = performance.now();
  const text = el.textContent || '';
  const isMoney = text.startsWith('$');
  const isPercent = text.endsWith('%');
  const hasDecimal = text.includes('.') && !isMoney;

  function animate(now: number): void {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = target * eased;

    if (isMoney) {
      el.textContent = '$' + Math.round(current).toLocaleString();
    } else if (isPercent) {
      el.textContent = current.toFixed(1) + '%';
    } else if (hasDecimal) {
      el.textContent = current.toFixed(1);
    } else {
      el.textContent = Math.round(current).toLocaleString();
    }

    if (progress < 1) requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

// Track which slides have been animated
const slidesAnimated: Set<number> = new Set();

function initReport(): void {
  const slides = document.querySelectorAll('.slide');
  const navDots = document.getElementById('navDots');

  // Create navigation dots
  if (navDots) {
    slides.forEach((_, i) => {
      const dot = document.createElement('div');
      dot.className = 'nav-dot' + (i === 0 ? ' active' : '');
      dot.addEventListener('click', () => {
        const slide = slides[i];
        if (slide) {
          slide.scrollIntoView({ behavior: 'smooth' });
        }
      });
      navDots.appendChild(dot);
    });
  }

  // Update navigation dots on scroll
  function updateNavDots(): void {
    const windowHeight = window.innerHeight;
    let activeIndex = 0;

    slides.forEach((slide, i) => {
      const rect = (slide as HTMLElement).getBoundingClientRect();
      if (rect.top <= windowHeight / 2 && rect.bottom >= windowHeight / 2) {
        activeIndex = i;
      }
    });

    document.querySelectorAll('.nav-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === activeIndex);
    });

    // Trigger animations for current slide
    if (!slidesAnimated.has(activeIndex)) {
      slidesAnimated.add(activeIndex);
      const currentSlide = slides[activeIndex];
      if (currentSlide) {
        currentSlide.classList.add('active');
        // Animate count-up numbers in this slide
        currentSlide.querySelectorAll('.count-up').forEach(el => {
          animateCountUp(el as HTMLElement);
        });
      }
    }
  }

  // Initial update
  updateNavDots();

  // Scroll listener
  let scrollTimeout: number | null = null;
  window.addEventListener('scroll', () => {
    if (scrollTimeout) return;
    scrollTimeout = requestAnimationFrame(() => {
      updateNavDots();
      scrollTimeout = null;
    });
  }, { passive: true });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      const currentIndex = Array.from(slides).findIndex(slide => {
        const rect = (slide as HTMLElement).getBoundingClientRect();
        return rect.top >= -50 && rect.top < window.innerHeight / 2;
      });
      const nextSlide = slides[currentIndex + 1];
      if (currentIndex < slides.length - 1 && nextSlide) {
        nextSlide.scrollIntoView({ behavior: 'smooth' });
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const currentIndex = Array.from(slides).findIndex(slide => {
        const rect = (slide as HTMLElement).getBoundingClientRect();
        return rect.top >= -50 && rect.top < window.innerHeight / 2;
      });
      const prevSlide = slides[currentIndex - 1];
      if (currentIndex > 0 && prevSlide) {
        prevSlide.scrollIntoView({ behavior: 'smooth' });
      }
    }
  });

  // Mark first slide as active immediately
  const firstSlide = slides[0];
  if (firstSlide) {
    firstSlide.classList.add('active');
    slidesAnimated.add(0);
  }
}

// Render charts for a specific panel when opened
function renderPanelCharts(panelId: string): void {
  const charts = window.REPORT_CHARTS;

  switch (panelId) {
    case 'generation':
      renderChart('chart-daily', charts.dailyProfile);
      break;
    case 'selfconsumption':
      // No chart in this panel
      break;
    case 'battery':
      renderChart('chart-battery', charts.batteryEfficiency);
      break;
    case 'savings':
      renderChart('chart-savings', charts.savingsComparison);
      break;
    case 'daily':
      // No chart in this panel
      break;
    case 'seasonal':
      renderChart('chart-seasonal', charts.seasonal);
      break;
    case 'tou':
      renderChart('chart-tou-import', charts.touImport);
      renderChart('chart-tou-export', charts.touExport);
      break;
    case 'scenarios':
      renderChart('chart-scenarios', charts.scenarios);
      break;
    case 'summary':
      // No chart in this panel
      break;
  }
}

// Export for global access
window.initReport = initReport;
window.renderPanelCharts = renderPanelCharts;
