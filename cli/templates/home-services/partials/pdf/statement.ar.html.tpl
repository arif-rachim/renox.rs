<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>كشف حساب {{ customer.name }}</title>
  <style>
    body { font-family: "Noto Naskh Arabic", "Noto Sans", sans-serif; font-size: 12pt; color: #1b1b1b; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    h2 { font-size: 14pt; margin: 16pt 0 0; }
    .brand { font-weight: bold; font-size: 14pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 8pt; }
    th { text-align: right; padding: 4pt; }
    td { padding: 4pt; border-bottom: 0.5pt solid #ccc; }
    .num { text-align: left; }
    .totals td { border: 0; }
    .muted { color: #666; font-size: 9pt; }
  </style>
</head>
<body>
  <p class="brand" :style="brand.text_style">{{ brand.name }}</p>
  <h1>كشف حساب</h1>
  <p>التاريخ: {{ date }}</p>
  <p><strong>{{ customer.name }}</strong><br>
    <span r-if="customer.trn">الرقم الضريبي: {{ customer.trn }}<br></span>
    <span dir="ltr">{{ customer.phone }}</span></p>
  <h2>الفواتير</h2>
  <table id="invoices">
    <thead><tr :style="brand.rule_style"><th>الفاتورة</th><th>التاريخ</th><th>الاستحقاق</th><th>الحالة</th><th class="num">الإجمالي (درهم)</th><th class="num">المدفوع (درهم)</th><th class="num">الرصيد (درهم)</th></tr></thead>
    <tbody>
      <tr r-for="i in invoices"><td>{{ i.number }}</td><td>{{ i.date }}</td><td>{{ i.due }}</td><td>{{ i.status }}</td><td class="num">{{ i.total | number(2) }}</td><td class="num">{{ i.paid | number(2) }}</td><td class="num">{{ i.balance | number(2) }}</td></tr>
      <tr r-empty="invoices"><td colspan="7">لا توجد فواتير.</td></tr>
    </tbody>
  </table>
  <h2>الدفعات</h2>
  <table id="payments">
    <thead><tr :style="brand.rule_style"><th>التاريخ</th><th>الفاتورة</th><th>الطريقة</th><th>المرجع</th><th class="num">المبلغ (درهم)</th></tr></thead>
    <tbody>
      <tr r-for="p in payments"><td>{{ p.date }}</td><td>{{ p.invoice }}</td><td>{{ p.method }}</td><td>{{ p.reference }}</td><td class="num">{{ p.amount | number(2) }}</td></tr>
      <tr r-empty="payments"><td colspan="5">لا توجد دفعات.</td></tr>
    </tbody>
  </table>
  <table class="totals">
    <tr><td></td><td class="num">المفوتر</td><td class="num">{{ totals.invoiced | number(2) }}</td></tr>
    <tr><td></td><td class="num">المدفوع</td><td class="num">{{ totals.paid | number(2) }}</td></tr>
    <tr><td></td><td class="num"><strong>الرصيد المستحق (درهم)</strong></td><td class="num"><strong>{{ totals.balance | number(2) }}</strong></td></tr>
  </table>
  <p class="muted">{{ brand.footer }}</p>
</body>
</html>
