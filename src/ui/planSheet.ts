import { monthRange, planFor, setPlan } from '../plans';
import { app, toast, update } from './app';
import { esc, monthLabel } from './format';

export function openPlanSheet(month: string) {
  const { plan, own, set } = planFor(app.state.plans, month);
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const field = (id: string, label: string, value: number, hint: string) => `
    <label class="field"><span>${esc(label)}</span>
      <div class="money"><span>₹</span><input type="text" inputmode="numeric" id="${id}" value="${value ? Math.round(value) : ''}" placeholder="0" autocomplete="off"></div>
      <span class="tiny">${esc(hint)}</span></label>`;
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="Monthly plan">
    <div class="grab"></div>
    <h2>Plan for ${esc(monthLabel(month))}</h2>
    <p class="small muted" style="margin-top:-4px">${set && !own ? 'Carried forward from an earlier month. ' : ''}Saving here applies to ${esc(monthLabel(month))} and carries forward to new months until you change it. Earlier months keep their own numbers.</p>
    ${field('p-income', 'Income', plan.income, 'Your take-home money for the month')}
    ${field('p-spend', 'Expected spend', plan.expectedSpend, 'Everything except investments and self transfers (card bill payments are included)')}
    ${field('p-invest', 'Expected investment', plan.expectedInvestment, 'SIPs, stocks, gold, FDs, PPF/NPS…')}
    <p class="small" id="p-left"></p>
    <div class="row">
      ${own ? '<button class="btn danger" id="p-clear">Clear</button>' : ''}
      <button class="btn grow" id="p-cancel">Cancel</button>
      <button class="btn primary grow" id="p-save">Save</button>
    </div>
  </div>`;
  const num = (id: string) => {
    const v = parseFloat(backdrop.querySelector<HTMLInputElement>(`#${id}`)!.value.replace(/[^\d.]/g, ''));
    return Number.isFinite(v) ? v : 0;
  };
  const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const showLeft = () => {
    const left = num('p-income') - num('p-spend') - num('p-invest');
    backdrop.querySelector('#p-left')!.textContent = left >= 0
      ? `Planned saving: ${inrFmt.format(left)}`
      : `This plan spends and invests ${inrFmt.format(-left)} more than your income.`;
  };
  backdrop.addEventListener('input', showLeft);
  showLeft();
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#p-cancel')!.addEventListener('click', close);
  backdrop.querySelector('#p-clear')?.addEventListener('click', async () => {
    close();
    await update((s) => {
      const plans = { ...s.plans };
      delete plans[month];
      return { ...s, plans };
    });
    toast(`Plan cleared for ${monthLabel(month)}`);
  });
  backdrop.querySelector('#p-save')!.addEventListener('click', async () => {
    const next = { income: num('p-income'), expectedSpend: num('p-spend'), expectedInvestment: num('p-invest') };
    close();
    await update((s) => setPlan(s, month, next, monthRange(s)));
    toast(`Plan saved for ${monthLabel(month)}`);
  });
  document.body.append(backdrop);
  backdrop.querySelector<HTMLInputElement>('#p-income')!.focus();
}
