<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <title>{{ number }}</title>
  <style>
    body { font-family: "Noto Sans", sans-serif; font-size: 11pt; color: #1b1b1b; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    .brand { font-weight: bold; font-size: 14pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 12pt; }
    th { text-align: left; padding: 4pt; }
    td { padding: 4pt; border-bottom: 0.5pt solid #ccc; }
    .num { text-align: right; }
    .parties td { border: 0; vertical-align: top; width: 50%; padding-left: 0; }
    .totals td { border: 0; }
    .muted { color: #666; font-size: 9pt; }
  </style>
</head>
<body>
  <p class="brand" :style="brand.text_style">{{ brand.name }}</p>
  <p class="muted" r-if="company.trn">TRN: {{ company.trn }}</p>
  <h1>Purchase order {{ number }}</h1>
  <p>Date: {{ created_at }}<span r-if="expected_on"> · Expected on: {{ expected_on }}</span></p>
  <table class="parties">
    <tr>
      <td><strong>Supplier</strong><br>{{ supplier.name }}<br>
        <span r-if="supplier.trn">TRN: {{ supplier.trn }}<br></span>
        <span r-if="supplier.address">{{ supplier.address }}<br></span>
        <span r-if="supplier.phone">{{ supplier.phone }}</span></td>
      <td><strong>Deliver to</strong><br>{{ branch.name }}<br>{{ branch.area }}</td>
    </tr>
  </table>
  <table id="lines">
    <thead><tr :style="brand.rule_style"><th>SKU</th><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit cost (AED)</th><th class="num">Amount (AED)</th></tr></thead>
    <tbody>
      <tr r-for="l in lines"><td>{{ l.sku }}</td><td>{{ l.name }}</td><td class="num">{{ l.qty }}</td><td>{{ l.unit }}</td><td class="num">{{ l.unit_cost | number(2) }}</td><td class="num">{{ l.amount | number(2) }}</td></tr>
    </tbody>
  </table>
  <table class="totals">
    <tr><td></td><td class="num">Net</td><td class="num">{{ totals.net | number(2) }}</td></tr>
    <tr><td></td><td class="num">VAT</td><td class="num">{{ totals.vat | number(2) }}</td></tr>
    <tr><td></td><td class="num"><strong>Total (AED)</strong></td><td class="num"><strong>{{ totals.total | number(2) }}</strong></td></tr>
  </table>
  <p r-if="notes">{{ notes }}</p>
  <p><strong>Please quote this number on your delivery note and invoice.</strong></p>
  <p class="muted">{{ brand.footer }}</p>
</body>
</html>
