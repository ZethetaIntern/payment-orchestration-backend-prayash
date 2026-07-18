/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  FileText,
  HelpCircle,
  Play,
  RefreshCw,
  Sliders,
  Terminal,
  TrendingUp,
  XCircle
} from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'transactions' | 'scenarios' | 'logs'>('dashboard');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [circuitBreakers, setCircuitBreakers] = useState<any[]>([]);
  const [routingConfig, setRoutingConfig] = useState<any>({
    weight_success_rate: 0.35,
    weight_latency: 0.20,
    weight_cost: 0.20,
    weight_health: 0.15,
    weight_fit: 0.10
  });
  const [gateways, setGateways] = useState<any[]>([]);
  const [analyticsMetrics, setAnalyticsMetrics] = useState<any[]>([
    { gateway: 'razorpay', success_rate: 0.958, p95_latency_ms: 520 },
    { gateway: 'stripe', success_rate: 0.985, p95_latency_ms: 330 },
    { gateway: 'payu', success_rate: 0.915, p95_latency_ms: 750 },
    { gateway: 'upi', success_rate: 0.988, p95_latency_ms: 250 }
  ]);
  const [selectedTxn, setSelectedTxn] = useState<any | null>(null);
  const [txnTimeline, setTxnTimeline] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [scenarioOutput, setScenarioOutput] = useState<any | null>(null);
  const [reconciliationReport, setReconciliationReport] = useState<any | null>(null);

  // Poll server state every 1.5 seconds for instant dashboard updates
  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 1500);
    return () => clearInterval(interval);
  }, []);

  const fetchStats = async () => {
    try {
      const [resTxns, resLogs, resCBs, resWeights, resGateways, resMetrics] = await Promise.all([
        fetch('/api/dev/transactions'),
        fetch('/api/dev/logs'),
        fetch('/api/dev/circuit-breakers'),
        fetch('/api/v1/routing/config'),
        fetch('/api/v1/gateways'),
        fetch('/api/v1/analytics/success-rate')
      ]);

      const dataTxns = await resTxns.json();
      const dataLogs = await resLogs.json();
      const dataCBs = await resCBs.json();
      const dataWeights = await resWeights.json();
      const dataGateways = await resGateways.json();
      const dataMetrics = await resMetrics.json();

      setTransactions(dataTxns);
      setLogs(dataLogs);
      setCircuitBreakers(dataCBs);
      setRoutingConfig(dataWeights);
      setGateways(dataGateways);
      setAnalyticsMetrics(dataMetrics);
    } catch (err) {
      console.error('Error fetching dashboard stats:', err);
    }
  };

  const handleSelectTxn = async (txn: any) => {
    setSelectedTxn(txn);
    try {
      const resTimeline = await fetch(`/api/v1/payments/${txn.id}/timeline`);
      const timeline = await resTimeline.json();
      setTxnTimeline(timeline);
    } catch (err) {
      console.error('Error fetching transaction timeline:', err);
    }
  };

  const updateRoutingWeights = async (key: string, value: number) => {
    const updated = { ...routingConfig, [key]: value };
    try {
      await fetch('/api/v1/routing/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      fetchStats();
    } catch (err) {
      console.error('Error updating weights:', err);
    }
  };

  const triggerScenario = async (scenarioId: string) => {
    setIsLoading(true);
    setScenarioOutput(null);
    try {
      const res = await fetch(`/api/dev/scenarios/${scenarioId}/trigger`, {
        method: 'POST'
      });
      const data = await res.json();
      setScenarioOutput(data);
      fetchStats();
    } catch (err: any) {
      setScenarioOutput({ error: err.message });
    } finally {
      setIsLoading(false);
    }
  };

  const runReconciliation = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/reconciliation/trigger', {
        method: 'POST'
      });
      const data = await res.json();
      setReconciliationReport(data);
      fetchStats();
    } catch (err) {
      console.error('Error running reconciliation:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Helper colors
  const getStateBadgeColor = (state: string) => {
    switch (state) {
      case 'CAPTURED':
      case 'SETTLED':
      case 'REFUNDED':
      case 'VOIDED':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'AUTHORISED':
      case 'PARTIALLY_CAPTURED':
      case 'PARTIALLY_REFUNDED':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'CREATED':
      case 'ROUTE_SELECTED':
        return 'bg-gray-50 text-gray-700 border-gray-200';
      case 'AUTH_INITIATED':
      case 'CAPTURE_INITIATED':
      case 'REFUND_INITIATED':
      case 'VOID_INITIATED':
        return 'bg-amber-50 text-amber-700 border-amber-200/60';
      case 'FAILED':
      case 'AUTH_FAILED':
      case 'CAPTURE_FAILED':
      case 'REFUND_FAILED':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  // Analytical Calculations
  const totalVolume = transactions.reduce((acc, t) => acc + (t.state === 'CAPTURED' || t.state === 'SETTLED' ? t.amount_paise : 0), 0);
  const totalTransactionsCount = transactions.length;
  const successfulTransactions = transactions.filter((t) => t.state === 'CAPTURED' || t.state === 'SETTLED' || t.state === 'REFUNDED').length;
  const successRatePercentage = totalTransactionsCount > 0 ? ((successfulTransactions / totalTransactionsCount) * 100).toFixed(1) : '100.0';

  // Area Chart Mock Trend
  const chartData = [
    { name: '10:00', volume: 45000 },
    { name: '11:00', volume: 68000 },
    { name: '12:00', volume: 124000 },
    { name: '13:00', volume: 89000 },
    { name: '14:00', volume: 165000 },
    { name: '15:00', volume: totalVolume / 100 || 220000 }
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans" id="app_root">
      {/* Header Panel */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center shrink-0" id="app_header">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold shadow-sm">
            <Cpu className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900 flex items-center gap-1.5">
              PayFlow <span className="text-slate-400 font-normal">Orchestrator v1.2</span>
            </h1>
            <p className="text-xs text-slate-500 font-medium">Enterprise Orchestration & Multi-Gateway Failover Engine</p>
          </div>
        </div>

        {/* Quick KPI stats */}
        <div className="hidden lg:flex items-center gap-4">
          <div className="flex items-center bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100 shadow-2xs">
            <span className="w-2 h-2 bg-emerald-500 rounded-full mr-2"></span>
            <span className="text-xs font-semibold text-emerald-700 uppercase tracking-wider">Success Rate: {successRatePercentage}%</span>
          </div>
          <div className="flex items-center bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100 shadow-2xs">
            <span className="w-2 h-2 bg-indigo-500 rounded-full mr-2"></span>
            <span className="text-xs font-semibold text-indigo-700 uppercase tracking-wider">Volume: ₹{(totalVolume / 100).toLocaleString('en-IN')}</span>
          </div>
        </div>

        {/* Navigation tabs */}
        <nav className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'dashboard' ? 'bg-white text-indigo-600 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('transactions')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'transactions' ? 'bg-white text-indigo-600 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Transactions
          </button>
          <button
            onClick={() => setActiveTab('scenarios')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'scenarios' ? 'bg-white text-indigo-600 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Scenarios
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'logs' ? 'bg-white text-indigo-600 font-bold shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Terminal
          </button>
        </nav>
      </header>

      {/* Main Content Pane */}
      <main className="flex-1 overflow-auto p-6" id="app_main_content">
        {activeTab === 'dashboard' && (
          <div className="space-y-6" id="dashboard_panel">
            {/* Bento Grid Analytics */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {/* Total volume card */}
              <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start text-slate-500">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Settled Volume</span>
                    <Coins className="w-4 h-4 text-indigo-600" />
                  </div>
                  <h2 className="text-2xl font-bold text-slate-900 mt-2 font-mono">₹{(totalVolume / 100).toLocaleString('en-IN')}</h2>
                </div>
                <div className="text-[10px] text-slate-400 font-semibold font-mono mt-4">Paise Precision Store (BIGINT)</div>
              </div>

              {/* Success rate card */}
              <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start text-slate-500">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Success Rate</span>
                    <Activity className="w-4 h-4 text-emerald-500" />
                  </div>
                  <h2 className="text-2xl font-bold text-slate-900 mt-2 font-mono">{successRatePercentage}%</h2>
                  <div className="w-full bg-slate-100 h-1.5 mt-3 rounded-full overflow-hidden">
                    <div className="bg-emerald-500 h-full transition-all duration-500" style={{ width: `${successRatePercentage}%` }}></div>
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 font-semibold font-mono mt-4">Sliding P95 Performance Window</div>
              </div>

              {/* Transactions count card */}
              <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start text-slate-500">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Total Transactions</span>
                    <FileText className="w-4 h-4 text-indigo-500" />
                  </div>
                  <h2 className="text-2xl font-bold text-slate-900 mt-2 font-mono">{totalTransactionsCount}</h2>
                </div>
                <div className="text-[10px] text-slate-400 font-semibold font-mono mt-4">Includes retries & failovers</div>
              </div>

              {/* System health state */}
              <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start text-slate-500">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">System Integrity</span>
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-base font-bold text-emerald-700 uppercase tracking-wider">Active & Healthy</span>
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 font-semibold font-mono mt-4">Auto failover threshold &lt; 2s</div>
              </div>
            </div>

            {/* Middle row: Routing Config & Gateway Status */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Routing Weights Settings */}
              <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm">
                <h3 className="text-sm font-bold tracking-tight text-slate-800 flex items-center gap-2 mb-4">
                  <Sliders className="w-4 h-4 text-indigo-600" />
                  Routing Weight Coefficients (Section A3.1)
                </h3>
                <p className="text-xs text-slate-500 mb-6 font-medium">Adjust weight distribution dynamically to influence multi-criteria gateway selection scoring in real-time.</p>

                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs text-slate-600 font-semibold mb-1">
                      <span>Success Rate Coefficient (35%)</span>
                      <span className="font-mono text-indigo-600">{(routingConfig.weight_success_rate * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1.0"
                      step="0.05"
                      value={routingConfig.weight_success_rate}
                      onChange={(e) => updateRoutingWeights('weight_success_rate', parseFloat(e.target.value))}
                      className="w-full accent-indigo-600 bg-slate-100 rounded-lg cursor-pointer h-2"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-slate-600 font-semibold mb-1">
                      <span>P95 Latency Coefficient (20%)</span>
                      <span className="font-mono text-indigo-600">{(routingConfig.weight_latency * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1.0"
                      step="0.05"
                      value={routingConfig.weight_latency}
                      onChange={(e) => updateRoutingWeights('weight_latency', parseFloat(e.target.value))}
                      className="w-full accent-indigo-600 bg-slate-100 rounded-lg cursor-pointer h-2"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-slate-600 font-semibold mb-1">
                      <span>Gateway Cost Optimization (20%)</span>
                      <span className="font-mono text-indigo-600">{(routingConfig.weight_cost * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1.0"
                      step="0.05"
                      value={routingConfig.weight_cost}
                      onChange={(e) => updateRoutingWeights('weight_cost', parseFloat(e.target.value))}
                      className="w-full accent-indigo-600 bg-slate-100 rounded-lg cursor-pointer h-2"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-slate-600 font-semibold mb-1">
                      <span>Health & Circuit Breaker State (15%)</span>
                      <span className="font-mono text-indigo-600">{(routingConfig.weight_health * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1.0"
                      step="0.05"
                      value={routingConfig.weight_health}
                      onChange={(e) => updateRoutingWeights('weight_health', parseFloat(e.target.value))}
                      className="w-full accent-indigo-600 bg-slate-100 rounded-lg cursor-pointer h-2"
                    />
                  </div>
                </div>
              </div>

              {/* Gateway Health Statuses */}
              <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm lg:col-span-2">
                <h3 className="text-sm font-bold tracking-tight text-slate-800 flex items-center justify-between mb-4">
                  <span className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-indigo-600" />
                    Gateway Status & Dynamic Circuit Breakers (A3.3)
                  </span>
                  <button
                    onClick={runReconciliation}
                    className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 hover:bg-slate-100 text-xs text-slate-700 px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Run Reconciliation
                  </button>
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {gateways.map((g) => {
                    const cbCard = circuitBreakers.find((cb) => cb.gateway === g.gateway && cb.payment_method === 'CARD');
                    const cbUpi = circuitBreakers.find((cb) => cb.gateway === g.gateway && cb.payment_method === 'UPI');
                    const metrics = analyticsMetrics.find((m) => m.gateway === g.gateway);

                    return (
                      <div key={g.gateway} className="bg-slate-50 border border-slate-200 p-4 rounded-xl space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">{g.gateway}</h4>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            g.is_active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'
                          }`}>
                            {g.is_active ? 'Active' : 'Disabled'}
                          </span>
                        </div>

                        {/* Performance Details */}
                        <div className="grid grid-cols-3 gap-2 text-center text-[11px] bg-white py-2 rounded-lg border border-slate-200/80">
                          <div>
                            <span className="text-slate-500 block font-semibold">Success</span>
                            <span className="font-mono text-slate-900 font-bold">{(metrics?.success_rate ? metrics.success_rate * 100 : 95.0).toFixed(1)}%</span>
                          </div>
                          <div>
                            <span className="text-slate-500 block font-semibold">Latency</span>
                            <span className="font-mono text-slate-900 font-bold">{metrics?.p95_latency_ms || 350}ms</span>
                          </div>
                          <div>
                            <span className="text-slate-500 block font-semibold">Limit</span>
                            <span className="font-mono text-slate-900 font-bold">{g.rate_limit_per_second}/s</span>
                          </div>
                        </div>

                        {/* Circuit Breaker Status bar */}
                        <div className="space-y-1">
                          <div className="flex justify-between items-center text-[10px] text-slate-500 font-semibold">
                            <span>Card Method Circuit</span>
                            <span className={`font-bold uppercase ${
                              cbCard?.state === 'CLOSED' ? 'text-emerald-600' : cbCard?.state === 'OPEN' ? 'text-rose-600 animate-pulse' : 'text-amber-600'
                            }`}>
                              {cbCard?.state || 'CLOSED'}
                            </span>
                          </div>
                          {g.gateway === 'upi' && (
                            <div className="flex justify-between items-center text-[10px] text-slate-500 font-semibold">
                              <span>UPI Method Circuit</span>
                              <span className={`font-bold uppercase ${
                                cbUpi?.state === 'CLOSED' ? 'text-emerald-600' : cbUpi?.state === 'OPEN' ? 'text-rose-600 animate-pulse' : 'text-amber-600'
                              }`}>
                                {cbUpi?.state || 'CLOSED'}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {reconciliationReport && (
                  <div className="mt-4 bg-amber-50 border border-amber-200 p-3 rounded-xl flex items-start gap-2.5 text-xs text-amber-800">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                    <div>
                      <p className="font-bold">Reconciliation Run Completed ({reconciliationReport.run_id})</p>
                      <p className="font-medium mt-1 text-amber-700">
                        Processed: {reconciliationReport.processedCount} transactions.
                        Discrepancies Corrected: {reconciliationReport.discrepancyCount}.
                        Critical Anomalies Flagged: {reconciliationReport.anomalyCount}.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Row: Volume Analytics chart */}
            <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm">
              <h3 className="text-sm font-bold tracking-tight text-slate-800 flex items-center gap-2 mb-4">
                <TrendingUp className="w-4 h-4 text-indigo-600" />
                Real-Time Volume & Load Trend
              </h3>
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="colorVolume" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.15}/>
                        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="name" stroke="#64748b" fontSize={11} tickLine={false} />
                    <YAxis stroke="#64748b" fontSize={11} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e2e8f0', color: '#0f172a', borderRadius: '8px' }} />
                    <Area type="monotone" dataKey="volume" stroke="#4f46e5" fillOpacity={1} fill="url(#colorVolume)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* Transactions list page */}
        {activeTab === 'transactions' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" id="transactions_panel">
            {/* Left side list */}
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm text-slate-900">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" />
                Processed Transactions Table
              </h3>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 uppercase tracking-wider font-bold">
                      <th className="py-3 px-2">Order ID</th>
                      <th className="py-3 px-2">Gateway</th>
                      <th className="py-3 px-2">Amount</th>
                      <th className="py-3 px-2">State Machine Status</th>
                      <th className="py-3 px-2">Created At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-600 font-semibold">
                    {transactions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400 font-semibold text-sm">
                          No transactions found. Trigger some scenarios!
                        </td>
                      </tr>
                    ) : (
                      transactions.map((t) => (
                        <tr
                          key={t.id}
                          onClick={() => handleSelectTxn(t)}
                          className={`cursor-pointer transition hover:bg-slate-50/50 ${selectedTxn?.id === t.id ? 'bg-indigo-50/70 border-l-2 border-indigo-600' : ''}`}
                        >
                          <td className="py-3 px-2 font-mono font-bold text-indigo-600">{t.merchant_order_id}</td>
                          <td className="py-3 px-2 font-mono uppercase text-slate-700">{t.selected_gateway || 'None'}</td>
                          <td className="py-3 px-2 font-mono text-slate-900 font-bold">₹{(t.amount_paise / 100).toFixed(2)}</td>
                          <td className="py-3 px-2">
                            <span className={`inline-block px-2.5 py-0.5 rounded-full border text-[10px] font-bold ${getStateBadgeColor(t.state)}`}>
                              {t.state}
                            </span>
                          </td>
                          <td className="py-3 px-2 text-slate-500 text-[11px] font-semibold">{new Date(t.created_at).toLocaleTimeString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right side Timeline Detail */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm text-slate-900">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-600" />
                Audit Trail Timeline (Section A2.3)
              </h3>

              {!selectedTxn ? (
                <div className="h-48 border border-dashed border-slate-200 rounded-xl flex items-center justify-center text-slate-400 text-xs font-semibold">
                  Select a transaction to view audit trails
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl space-y-1.5">
                    <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">Transaction Detail</p>
                    <div className="text-[11px] text-slate-600 font-semibold space-y-1">
                      <div className="flex justify-between"><span className="text-slate-500">Order ID:</span> <span className="font-mono text-slate-900 font-bold">{selectedTxn.merchant_order_id}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Transaction ID:</span> <span className="font-mono text-slate-900 font-bold">{selectedTxn.id}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Gateway Ref:</span> <span className="font-mono text-indigo-600 font-bold">{selectedTxn.gateway_reference || 'N/A'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Trace ID:</span> <span className="font-mono text-indigo-600 font-bold">{selectedTxn.trace_id}</span></div>
                    </div>
                  </div>

                  <div className="space-y-3 relative before:absolute before:left-[17px] before:top-2 before:bottom-2 before:w-[2px] before:bg-slate-200">
                    {txnTimeline.map((log) => (
                      <div key={log.id} className="flex gap-4 relative">
                        {/* Dot indicator */}
                        <div className={`w-9 h-9 rounded-full border flex items-center justify-center shrink-0 z-10 ${
                          log.event === 'REJECTED_TRANSITION' ? 'bg-rose-50 text-rose-500 border-rose-200' : 'bg-slate-50 text-slate-600 border-slate-200'
                        }`}>
                          {log.event === 'REJECTED_TRANSITION' ? <XCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                        </div>

                        <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl flex-1 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-slate-800">{log.event}</span>
                            <span className="text-[9px] text-slate-400 font-mono font-bold">{new Date(log.created_at).toLocaleTimeString()}</span>
                          </div>
                          <p className="text-[10px] text-slate-600 font-medium">
                            State transition: <span className="text-slate-700 font-bold">{log.from_state || 'START'}</span> → <span className="text-indigo-600 font-bold">{log.to_state}</span>
                          </p>
                          {log.metadata && (
                            <pre className="text-[9px] bg-slate-900 p-1.5 border border-slate-800 text-slate-300 overflow-x-auto font-mono mt-2 rounded">
                              {JSON.stringify(JSON.parse(log.metadata), null, 2)}
                            </pre>
                          )}
                          <p className="text-[9px] text-slate-400 font-bold uppercase mt-1">Actor: {log.created_by}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Failure Scenarios Panel */}
        {activeTab === 'scenarios' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" id="scenarios_panel">
            {/* Scenarios triggers */}
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm text-slate-900">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-indigo-600" />
                Automated Failure Scenario Playground (Section B2)
              </h3>
              <p className="text-xs text-slate-500 font-medium">Trigger pre-configured system stress-tests and watch the multi-gateway orchestrator, circuit breakers, and state locks resolve them atomically in real-time.</p>

              <div className="space-y-3">
                {/* FS-01 */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-slate-800">FS-01: Gateway Timeout during Auth (Instant Failover)</h4>
                    <p className="text-[11px] text-slate-500">Razorpay times out. Circuit breaker increments error counter and instantly fails over to Stripe under 2 seconds.</p>
                  </div>
                  <button
                    onClick={() => triggerScenario('FS-01')}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    Trigger stress test
                  </button>
                </div>

                {/* FS-02 */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-slate-800">FS-02: Webhook Replay / Duplicate Delivery</h4>
                    <p className="text-[11px] text-slate-500">Simulates Razorpay sending duplicate webhook 3 times. Deduplication processes it once and ignores repeats cleanly.</p>
                  </div>
                  <button
                    onClick={() => triggerScenario('FS-02')}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    Trigger stress test
                  </button>
                </div>

                {/* FS-03 */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-slate-800">FS-03: Double Submit / Concurrency Race</h4>
                    <p className="text-[11px] text-slate-500">Simulates user double-clicking pay in microsecond intervals. Idempotency lock rejects second request instantly as 409 Conflict.</p>
                  </div>
                  <button
                    onClick={() => triggerScenario('FS-03')}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    Trigger stress test
                  </button>
                </div>

                {/* FS-04 */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-slate-800">FS-04: Gateway Returns 5xx on Capture (Late Success Poll)</h4>
                    <p className="text-[11px] text-slate-500">PayU capture triggers 502 Bad Gateway. System schedules late success poll status API to check server execution state.</p>
                  </div>
                  <button
                    onClick={() => triggerScenario('FS-04')}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    Trigger stress test
                  </button>
                </div>

                {/* FS-05 */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-slate-800">FS-05: Partial Capture with Remaining Hold</h4>
                    <p className="text-[11px] text-slate-500">Captures ₹800 of a ₹1,200 authorized hold. State machine transitions to PARTIALLY_CAPTURED and retains ₹400 balance.</p>
                  </div>
                  <button
                    onClick={() => triggerScenario('FS-05')}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    Trigger stress test
                  </button>
                </div>

                {/* FS-11 */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-slate-800">FS-11: Settlement Mismatch Anomaly Detection</h4>
                    <p className="text-[11px] text-slate-500">Triggers critical reconciliation warning: Transaction is marked CAPTURED internally but gateway reports FAILED on settlement.</p>
                  </div>
                  <button
                    onClick={() => triggerScenario('FS-11')}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    Trigger stress test
                  </button>
                </div>

                {/* FS-15 */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-slate-800">FS-15: State Machine State Corruption Bypass Block</h4>
                    <p className="text-[11px] text-slate-500">Simulates buggy handler trying to move CREATED directly to REFUNDED. State machine throws error & logs REJECTED_TRANSITION.</p>
                  </div>
                  <button
                    onClick={() => triggerScenario('FS-15')}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    Trigger stress test
                  </button>
                </div>
              </div>
            </div>

            {/* Right side live execution log display */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm text-slate-900">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-600" />
                Live Scenario Execution Log
              </h3>

              {!scenarioOutput ? (
                <div className="h-64 border border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center text-slate-400 text-xs text-center p-4">
                  <Terminal className="w-8 h-8 text-slate-300 mb-2" />
                  <span>Click "Trigger stress test" to run a failure scenario and view execution logs here</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                    <span className="font-bold text-indigo-600 uppercase tracking-wide">Test Scenario: {scenarioOutput.scenario || 'FS-02 Webhook'}</span>
                    <span className="text-[10px] font-mono text-emerald-600 font-bold">SUCCESS</span>
                  </div>

                  <pre className="text-[10px] bg-slate-900 border border-slate-800 p-3 rounded-xl text-emerald-400 overflow-x-auto font-mono max-h-96">
                    {JSON.stringify(scenarioOutput, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Live Logs Terminal tab */}
        {activeTab === 'logs' && (
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm text-slate-900" id="terminal_panel">
            <h3 className="text-sm font-bold text-slate-800 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-600" />
                Structured Trace Tracing Console (Section A8.5)
              </span>
              <span className="text-[10px] text-slate-400 font-mono font-bold uppercase">JSON Format</span>
            </h3>
            <p className="text-xs text-slate-500 font-medium">Observe trace IDs, gateway performance evaluations, and state logs flowing inside the microsecond backend context.</p>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 font-mono text-[11px] h-[500px] overflow-y-auto space-y-2 text-slate-300">
              {logs.map((log, index) => (
                <div key={index} className="border-b border-slate-800 pb-2 flex flex-col md:flex-row md:items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                        log.level === 'ERROR' ? 'bg-rose-500/20 text-rose-400' : log.level === 'WARN' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-cyan-400'
                      }`}>
                        {log.level}
                      </span>
                      <span className="text-slate-500 text-[10px] font-bold">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      <span className="text-indigo-400 font-bold">[{log.component}]</span>
                      <span className="text-emerald-400 font-bold">({log.action})</span>
                    </div>
                    <p className="text-slate-100 font-medium">{log.message}</p>
                    {log.metadata && (
                      <span className="text-slate-500 block text-[9px] mt-0.5">Metadata: {JSON.stringify(log.metadata)}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500 font-bold md:text-right shrink-0">
                    <div className="text-indigo-400">Trace: {log.trace_id}</div>
                    {log.transaction_id && <div className="text-slate-400">Txn: {log.transaction_id}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer credits */}
      <footer className="border-t border-slate-200 bg-white text-slate-500 text-xs px-6 py-4 flex items-center justify-between" id="app_footer_info">
        <span className="font-semibold text-slate-500">PayFlow Commerce Private Limited © 2026</span>
        <span className="font-mono text-[10px] font-bold">Compliance-certified PCI-DSS and RBI Guidelines</span>
      </footer>
    </div>
  );
}
