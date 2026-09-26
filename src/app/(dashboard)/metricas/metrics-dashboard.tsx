"use client";

import { useEffect, useState } from "react";
import { formatCentsAsArs } from "@/lib/money";
import { METRICS_RANGE_LABEL, type MetricsRangeKey } from "@/lib/metrics/date-range";

export type MetricsData = {
  range: { key: string; from: string; to: string };
  totalOrders: number;
  totalRevenueCents: number;
  averageOrderCents: number;
  cash: { orders: number; revenueCents: number };
  transfer: { orders: number; revenueCents: number };
  daily: Array<{ date: string; orders: number; revenueCents: number }>;
};

const RANGE_OPTIONS: MetricsRangeKey[] = ["hoy", "semana", "mes", "personalizado"];

// Verde de acento ya usado en el resto del panel (botones, hover de tarjetas
// de pedido) — validado con el validador de paletas del skill de dataviz
// (una sola serie, no necesita separación CVD entre matices, solo contraste
// contra la superficie: PASA >= 3:1).
const BAR_COLOR = "#16a34a";

export function MetricsDashboard({ initialData }: { initialData: MetricsData | null }) {
  const [rangeKey, setRangeKey] = useState<MetricsRangeKey>("hoy");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState<MetricsData | null>(initialData);
  const [loading, setLoading] = useState(false);

  async function loadRange(key: MetricsRangeKey, from?: string, to?: string) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ range: key });
      if (key === "personalizado" && from && to) {
        params.set("from", from);
        params.set("to", to);
      }
      const response = await fetch(`/api/metricas?${params.toString()}`);
      if (response.ok) setData(await response.json());
    } finally {
      setLoading(false);
    }
  }

  function handleRangeChange(key: MetricsRangeKey) {
    setRangeKey(key);
    if (key !== "personalizado") loadRange(key);
  }

  useEffect(() => {
    if (rangeKey === "personalizado" && customFrom && customTo) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- recarga cuando el usuario termina de elegir ambas fechas, no hay forma de evitar el setState acá
      loadRange("personalizado", customFrom, customTo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customFrom, customTo]);

  return (
    <div className="flex h-screen flex-col overflow-y-auto p-8">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-semibold text-gray-900">Métricas</h1>
        <p className="mt-1 text-sm text-gray-500">Ventas de la sucursal: pedidos, facturación y medios de pago.</p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {RANGE_OPTIONS.map((key) => (
          <button
            key={key}
            onClick={() => handleRangeChange(key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              rangeKey === key ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {METRICS_RANGE_LABEL[key]}
          </button>
        ))}
        {rangeKey === "personalizado" && (
          <div className="flex items-center gap-2 text-sm">
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1"
            />
            <span className="text-gray-400">a</span>
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1"
            />
          </div>
        )}
      </div>

      {!data ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          No se pudieron cargar las métricas.
        </div>
      ) : (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile label="Pedidos" value={data.totalOrders.toLocaleString("es-AR")} />
            <StatTile label="Facturación" value={formatCentsAsArs(data.totalRevenueCents)} />
            <StatTile label="Ticket promedio" value={formatCentsAsArs(data.averageOrderCents)} />
            <PaymentSplitTile cash={data.cash} transfer={data.transfer} />
          </div>

          <div className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-700">Facturación por día</h2>
            {data.daily.length === 0 ? (
              <p className="mt-4 text-sm text-gray-500">No hay pedidos en este rango.</p>
            ) : (
              <DailyRevenueChart daily={data.daily} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function PaymentSplitTile({ cash, transfer }: { cash: MetricsData["cash"]; transfer: MetricsData["transfer"] }) {
  const totalRevenueCents = cash.revenueCents + transfer.revenueCents;
  const cashPct = totalRevenueCents > 0 ? Math.round((cash.revenueCents / totalRevenueCents) * 100) : 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-sm text-gray-500">Efectivo vs. transferencia</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{cashPct}% efectivo</div>
      <div className="mt-1 text-xs text-gray-400">
        {cash.orders} efectivo ({formatCentsAsArs(cash.revenueCents)}) · {transfer.orders} transferencia (
        {formatCentsAsArs(transfer.revenueCents)})
      </div>
    </div>
  );
}

function computeNiceMax(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function formatCompactArs(cents: number): string {
  const value = cents / 100;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })}M`;
  if (value >= 1_000) return `$${(value / 1_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })}K`;
  return `$${value.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

function formatDayLabel(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return `${day}/${month}`;
}

function formatFullDayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(
    new Date(`${dateKey}T00:00:00Z`),
  );
}

// Gráfico de barras de una sola serie (facturación por día). Sigue el skill
// de dataviz: eje único, barras finas con extremo redondeado y base cuadrada,
// grilla en gris recesivo, hover por barra con hit target más ancho que la
// barra, y una única etiqueta directa (el pico) en vez de un valor en cada
// punto.
function DailyRevenueChart({ daily }: { daily: MetricsData["daily"] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 720;
  const height = 240;
  const paddingLeft = 56;
  const paddingRight = 8;
  const paddingTop = 28;
  const paddingBottom = 28;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const maxRevenue = Math.max(...daily.map((point) => point.revenueCents), 0);
  const niceMax = computeNiceMax(maxRevenue);
  const ticks = [0, niceMax / 2, niceMax];

  const barSlot = plotWidth / daily.length;
  const barWidth = Math.max(4, Math.min(24, barSlot - 4));
  const labelStride = Math.max(1, Math.ceil(daily.length / 8));
  const peakIndex = daily.reduce(
    (best, point, index) => (point.revenueCents > daily[best].revenueCents ? index : best),
    0,
  );

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Facturación por día">
        {ticks.map((tick) => {
          const y = paddingTop + plotHeight - (tick / niceMax) * plotHeight;
          return (
            <g key={tick}>
              <line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} stroke="#e1e0d9" strokeWidth={1} />
              <text x={paddingLeft - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#898781">
                {formatCompactArs(tick)}
              </text>
            </g>
          );
        })}
        <line
          x1={paddingLeft}
          x2={width - paddingRight}
          y1={paddingTop + plotHeight}
          y2={paddingTop + plotHeight}
          stroke="#c3c2b7"
          strokeWidth={1}
        />

        {daily.map((point, index) => {
          const barHeight = niceMax > 0 ? (point.revenueCents / niceMax) * plotHeight : 0;
          const x = paddingLeft + index * barSlot + (barSlot - barWidth) / 2;
          const y = paddingTop + plotHeight - barHeight;
          const isDimmed = hoverIndex !== null && hoverIndex !== index;
          return (
            <g key={point.date}>
              {index === peakIndex && (
                <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" fontSize={11} fill="#52514e">
                  {formatCompactArs(point.revenueCents)}
                </text>
              )}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, 1)}
                rx={4}
                fill={BAR_COLOR}
                opacity={isDimmed ? 0.45 : 1}
              />
              {index % labelStride === 0 && (
                <text
                  x={paddingLeft + index * barSlot + barSlot / 2}
                  y={paddingTop + plotHeight + 18}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#898781"
                >
                  {formatDayLabel(point.date)}
                </text>
              )}
              {/* Hit target más ancho que la barra: el hover no depende de acertarle a los <=24px exactos. */}
              <rect
                x={paddingLeft + index * barSlot}
                y={paddingTop}
                width={barSlot}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(index)}
                onMouseLeave={() => setHoverIndex((current) => (current === index ? null : current))}
              />
            </g>
          );
        })}
      </svg>

      <div className="mt-2 h-8">
        {hoverIndex !== null && (
          <div className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700">
            <span className="font-medium">{formatFullDayLabel(daily[hoverIndex].date)}</span>
            <span className="text-gray-400">·</span>
            <span>{formatCentsAsArs(daily[hoverIndex].revenueCents)}</span>
            <span className="text-gray-400">·</span>
            <span>
              {daily[hoverIndex].orders} {daily[hoverIndex].orders === 1 ? "pedido" : "pedidos"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
