<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <title>Statement {{ customer.name }}</title>
  <style>
    body { font-family: "Noto Sans", sans-serif; font-size: 11pt; color: #1b1b1b; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    h2 { font-size: 13pt; margin: 16pt 0 0; }
    .brand { font-weight: bold; font-size: 14pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 8pt; }
    th { text-align: left; padding: 4pt; }
    td { padding: 4pt; border-bottom: 0.5pt solid #ccc; }
    .num { text-align: right; }
    .totals td { border: 0; }
    .muted { color: #666; font-size: 9pt; }
  </style>
</head>
<body>
  <p class="brand" :style="brand.text_style">{{ brand.name }}</p>
  <h1>Statement of account</h1>
  <p>Date: {{ date }}</p>
  <p><strong>{{ customer.name }}</strong><br>
    <span r-if="customer.trn">TRN: {{ customer.trn }}<br></span>
    {{ customer.phone }}</p>
  <h2>Invoices</h2>
  <table id="invoices">
    <thead><tr :style="brand.rule_style"><th>Invoice</th><th>Date</th><th>Due</th><th>Status</th><th class="num">Total (AED)</th><th class="num">Paid (AED)</th><th class="num">Balance (AED)</th></tr></thead>
    <tbody>
      <tr r-for="i in invoices"><td>{{ i.number }}</td><td>{{ i.date }}</td><td>{{ i.due }}</td><td>{{ i.status }}</td><td class="num">{{ i.total | number(2) }}</td><td class="num">{{ i.paid | number(2) }}</td><td class="num">{{ i.balance | number(2) }}</td></tr>
      <tr r-empty="invoices"><td colspan="7">No invoices.</td></tr>
    </tbody>
  </table>
  <h2>Payments</h2>
  <table id="payments">
    <thead><tr :style="brand.rule_style"><th>Date</th><th>Invoice</th><th>Method</th><th>Reference</th><th class="num">Amount (AED)</th></tr></thead>
    <tbody>
      <tr r-for="p in payments"><td>{{ p.date }}</td><td>{{ p.invoice }}</td><td>{{ p.method }}</td><td>{{ p.reference }}</td><td class="num">{{ p.amount | number(2) }}</td></tr>
      <tr r-empty="payments"><td colspan="5">No payments.</td></tr>
    </tbody>
  </table>
  <table class="totals">
    <tr><td></td><td class="num">Invoiced</td><td class="num">{{ totals.invoiced | number(2) }}</td></tr>
    <tr><td></td><td class="num">Paid</td><td class="num">{{ totals.paid | number(2) }}</td></tr>
    <tr><td></td><td class="num"><strong>Balance due (AED)</strong></td><td class="num"><strong>{{ totals.balance | number(2) }}</strong></td></tr>
  </table>
  <p class="muted">{{ brand.footer }}</p>
</body>
</html>
