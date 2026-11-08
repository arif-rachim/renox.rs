<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <title>{{ number }}</title>
  <style>
    body { font-family: "Noto Sans", sans-serif; font-size: 11pt; color: #1b1b1b; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    h2 { font-size: 13pt; margin: 14pt 0 4pt; }
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
  <h1>Annual Maintenance Contract {{ number }}</h1>
  <p>Term: {{ starts_on }} to {{ ends_on }}</p>
  <table>
    <tr>
      <td><strong>Customer</strong><br>{{ customer.name }}<br><span r-if="customer.trn">TRN: {{ customer.trn }}<br></span>{{ customer.phone }}</td>
      <td><strong>Visits</strong><br>{{ total_visits }} planned visits a year</td>
    </tr>
  </table>
  <h2>Services and sites</h2>
  <table id="items">
    <thead><tr :style="brand.rule_style"><th>Service</th><th>Site</th><th class="num">Visits a year</th></tr></thead>
    <tbody>
      <tr r-for="i in items"><td>{{ i.service }}</td><td>{{ i.site }}<br><span class="muted">{{ i.address }}</span></td><td class="num">{{ i.visits_per_year }}</td></tr>
    </tbody>
  </table>
  <h2>Price</h2>
  <table class="totals">
    <tr><td></td><td class="num">Yearly price</td><td class="num">{{ price | number(2) }}</td></tr>
    <tr><td></td><td class="num">VAT 5 %</td><td class="num">{{ vat | number(2) }}</td></tr>
    <tr><td></td><td class="num"><strong>Total (AED)</strong></td><td class="num"><strong>{{ total | number(2) }}</strong></td></tr>
  </table>
  <p r-if="has_notes">{{ notes }}</p>
  <p class="muted">The yearly price is invoiced in advance. Each visit is scheduled with the customer ahead of time. We remind you 30 days before the contract ends.</p>
  <p class="muted">{{ brand.footer }}</p>
</body>
</html>
