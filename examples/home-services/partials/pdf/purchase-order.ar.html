<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>{{ number }}</title>
  <style>
    body { font-family: "Noto Naskh Arabic", "Noto Sans", sans-serif; font-size: 12pt; color: #1b1b1b; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    .brand { font-weight: bold; font-size: 14pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 12pt; }
    th { text-align: right; padding: 4pt; }
    td { padding: 4pt; border-bottom: 0.5pt solid #ccc; }
    .num { text-align: left; }
    .parties td { border: 0; vertical-align: top; width: 50%; padding-right: 0; }
    .totals td { border: 0; }
    .muted { color: #666; font-size: 9pt; }
  </style>
</head>
<body>
  <p class="brand" :style="brand.text_style">{{ brand.name }}</p>
  <p class="muted" r-if="company.trn">الرقم الضريبي: {{ company.trn }}</p>
  <h1>أمر شراء {{ number }}</h1>
  <p>التاريخ: {{ created_at }}<span r-if="expected_on"> · التسليم المتوقع: {{ expected_on }}</span></p>
  <table class="parties">
    <tr>
      <td><strong>المورّد</strong><br>{{ supplier.name }}<br>
        <span r-if="supplier.trn">الرقم الضريبي: {{ supplier.trn }}<br></span>
        <span r-if="supplier.address">{{ supplier.address }}<br></span>
        <span r-if="supplier.phone" dir="ltr">{{ supplier.phone }}</span></td>
      <td><strong>التسليم إلى</strong><br>{{ branch.name }}<br>{{ branch.area }}</td>
    </tr>
  </table>
  <table id="lines">
    <thead><tr :style="brand.rule_style"><th>الرمز</th><th>الصنف</th><th class="num">الكمية</th><th>الوحدة</th><th class="num">سعر الوحدة (درهم)</th><th class="num">المبلغ (درهم)</th></tr></thead>
    <tbody>
      <tr r-for="l in lines"><td>{{ l.sku }}</td><td>{{ l.name }}</td><td class="num">{{ l.qty }}</td><td>{{ l.unit }}</td><td class="num">{{ l.unit_cost | number(2) }}</td><td class="num">{{ l.amount | number(2) }}</td></tr>
    </tbody>
  </table>
  <table class="totals">
    <tr><td></td><td class="num">الصافي</td><td class="num">{{ totals.net | number(2) }}</td></tr>
    <tr><td></td><td class="num">ضريبة القيمة المضافة</td><td class="num">{{ totals.vat | number(2) }}</td></tr>
    <tr><td></td><td class="num"><strong>الإجمالي (درهم)</strong></td><td class="num"><strong>{{ totals.total | number(2) }}</strong></td></tr>
  </table>
  <p r-if="notes">{{ notes }}</p>
  <p><strong>يرجى ذكر هذا الرقم على إشعار التسليم والفاتورة.</strong></p>
  <p class="muted">{{ brand.footer }}</p>
</body>
</html>
