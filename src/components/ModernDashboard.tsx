import React, { useState } from "react";
import { 
  Users, 
  Phone, 
  Activity, 
  Settings, 
  LogOut, 
  BarChart3, 
  Clock, 
  ShieldCheck, 
  Search,
  Plus,
  Play,
  Monitor,
  HeartPulse
} from "lucide-react";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell
} from "recharts";
import { motion, AnimatePresence } from "motion/react";

interface ModernDashboardProps {
  user: any;
  mode: 'ADMIN' | 'MANAGER' | 'MONITOR';
  setMode: (mode: 'AGENT' | 'ADMIN' | 'MANAGER' | 'MONITOR') => void;
  logout: () => void;
  calls: any[];
  agents: any[];
  logs: any[];
  fetchAdminData: () => void;
  showNotify: (msg: string, type: string) => void;
}

const COLORS = ['#4f8ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function ModernDashboard({
  user,
  mode,
  setMode,
  logout,
  calls,
  agents,
  logs,
  fetchAdminData,
  showNotify
}: ModernDashboardProps) {
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'AGENTS' | 'CALLS' | 'SCRIPTS' | 'LOGS'>('OVERVIEW');

  const stats = [
    { label: "Active Calls", value: calls.filter(c => c.status === 'ACTIVE').length, icon: Phone, color: "text-blue-500" },
    { label: "On Hold", value: calls.filter(c => c.status === 'HOLD').length, icon: Clock, color: "text-yellow-500" },
    { label: "Online Agents", value: agents.filter(a => a.status !== 'offline').length, icon: Users, color: "text-green-500" },
    { label: "System Health", value: "99.9%", icon: HeartPulse, color: "text-red-500" },
  ];

  const chartData = [
    { time: '08:00', calls: 12 },
    { time: '10:00', calls: 45 },
    { time: '12:00', calls: 38 },
    { time: '14:00', calls: 62 },
    { time: '16:00', calls: 51 },
    { time: '18:00', calls: 24 },
  ];

  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newAgent, setNewAgent] = useState({ id: '', name: '', pin: '', loginCode: '' });

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/admin/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAgent)
      });
      if (res.ok) {
        showNotify(`Agent ${newAgent.id} created successfully`, 'ok');
        setShowAddAgent(false);
        setNewAgent({ id: '', name: '', pin: '', loginCode: '' });
        fetchAdminData();
      }
    } catch (err) {
      showNotify("Failed to create agent", "err");
    }
  };

  const deleteAgent = async (id: string) => {
    if (!window.confirm(`Are you sure you want to delete agent ${id}?`)) return;
    try {
      const res = await fetch(`/api/admin/agents/${id}`, { method: "DELETE" });
      if (res.ok) {
        showNotify(`Agent ${id} deleted`, 'warn');
        fetchAdminData();
      }
    } catch (err) {
      showNotify("Failed to delete agent", "err");
    }
  }

  const joinMonitor = async (sid: string) => {
    try {
      await fetch("/twilio/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid: sid, managerId: user.id })
      });
      showNotify(`Joining silent monitoring for ${sid}`, 'ok');
      setMode('AGENT'); // Switch to terminal to hear/see the call
    } catch (err) {
      showNotify("Monitoring failed", "err");
    }
  };

  return (
    <div className="flex h-screen bg-[#f8fafc] text-slate-800 font-sans relative">
      <AnimatePresence>
        {showAddAgent && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                <h3 className="font-bold text-slate-900 tracking-tight">Register New Terminal</h3>
                <button onClick={() => setShowAddAgent(false)} className="text-slate-400 hover:text-slate-600">&times;</button>
              </div>
              <form onSubmit={handleCreateAgent} className="p-8 space-y-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 tracking-wider">Terminal ID (e.g. agent-005)</label>
                    <input 
                      required
                      className="w-full px-4 py-3 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-blue-500 transition-all font-mono"
                      value={newAgent.id}
                      onChange={e => setNewAgent({...newAgent, id: e.target.value})}
                      placeholder="agent-xxx"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 tracking-wider">Full Name</label>
                    <input 
                      required
                      className="w-full px-4 py-3 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-blue-500 transition-all"
                      value={newAgent.name}
                      onChange={e => setNewAgent({...newAgent, name: e.target.value})}
                      placeholder="Jane Doe"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 tracking-wider">Auth PIN (4-digit)</label>
                      <input 
                        required
                        className="w-full px-4 py-3 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-blue-500 transition-all font-mono"
                        value={newAgent.pin}
                        onChange={e => setNewAgent({...newAgent, pin: e.target.value})}
                        placeholder="0000"
                        maxLength={4}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 tracking-wider">Login Code (7-digit)</label>
                      <input 
                        required
                        className="w-full px-4 py-3 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-blue-500 transition-all font-mono"
                        value={newAgent.loginCode}
                        onChange={e => setNewAgent({...newAgent, loginCode: e.target.value})}
                        placeholder="1234567"
                        maxLength={7}
                      />
                    </div>
                  </div>
                </div>
                <div className="flex gap-3 pt-4">
                  <button 
                    type="button"
                    onClick={() => setShowAddAgent(false)}
                    className="flex-1 px-4 py-3 bg-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 px-4 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 shadow-lg shadow-blue-100 transition-all"
                  >
                    Deploy Agent
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-6 flex items-center gap-3 border-b border-slate-100">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold">C</div>
          <span className="font-bold text-lg tracking-tight text-slate-900">Certxa <span className="text-blue-600">SaaS</span></span>
        </div>

        <nav className="flex-1 p-4 flex flex-col gap-1">
          <NavItem 
            icon={Activity} 
            label="Overview" 
            active={activeTab === 'OVERVIEW'} 
            onClick={() => setActiveTab('OVERVIEW')} 
          />
          <NavItem 
            icon={Users} 
            label="Agent Control" 
            active={activeTab === 'AGENTS'} 
            onClick={() => setActiveTab('AGENTS')} 
          />
          <NavItem 
            icon={Phone} 
            label="Live Queue" 
            active={activeTab === 'CALLS'} 
            onClick={() => setActiveTab('CALLS')} 
          />
          <NavItem 
            icon={ShieldCheck} 
            label="Audit Logs" 
            active={activeTab === 'LOGS'} 
            onClick={() => setActiveTab('LOGS')} 
          />
          <div className="mt-4 pt-4 border-t border-slate-100">
             <NavItem 
              icon={Monitor} 
              label="Switch to Terminal" 
              onClick={() => setMode('AGENT')} 
              variant="secondary"
            />
          </div>
        </nav>

        <div className="p-4 bg-slate-50 border-t border-slate-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold">
              {user?.name?.[0].toUpperCase()}
            </div>
            <div className="overflow-hidden">
              <div className="font-semibold text-sm truncate">{user?.name}</div>
              <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">{mode}</div>
            </div>
          </div>
          <button 
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-red-600 font-medium hover:bg-red-50 transition-colors"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8">
          <h1 className="text-lg font-semibold text-slate-900">{activeTab}</h1>
          <div className="flex items-center gap-4">
            <div className="relative group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                placeholder="Search resources..." 
                className="pl-10 pr-4 py-2 bg-slate-100 border-none rounded-full text-sm focus:ring-2 focus:ring-blue-500 w-64 transition-all"
              />
            </div>
            <button className="p-2 text-slate-400 hover:text-slate-600 transition-colors">
              <Settings size={20} />
            </button>
          </div>
        </header>

        {/* Scrollable Area */}
        <div className="flex-1 overflow-y-auto p-8">
          <AnimatePresence mode="wait">
            {activeTab === 'OVERVIEW' && (
              <motion.div 
                key="overview"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                {/* Stats Grid */}
                <div className="grid grid-cols-4 gap-6">
                  {stats.map((stat, i) => (
                    <div key={i} className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                      <div className="flex justify-between items-start mb-4">
                        <div className={`p-3 rounded-xl bg-slate-50 ${stat.color}`}>
                          <stat.icon size={24} />
                        </div>
                        <span className="text-[10px] font-bold text-green-500 bg-green-50 px-2 py-1 rounded-full">+12%</span>
                      </div>
                      <div className="text-slate-500 text-sm font-medium mb-1">{stat.label}</div>
                      <div className="text-3xl font-bold text-slate-900">{stat.value}</div>
                    </div>
                  ))}
                </div>

                {/* Charts Row */}
                <div className="grid grid-cols-3 gap-8">
                  <div className="col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-sm font-bold text-slate-900 mb-6 uppercase tracking-wider">Volume Dynamics (24h)</h3>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                          <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#94a3b8' }} dy={10} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#94a3b8' }} />
                          <Tooltip 
                            contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
                          />
                          <Line 
                            type="monotone" 
                            dataKey="calls" 
                            stroke="#3b82f6" 
                            strokeWidth={3} 
                            dot={{ fill: '#3b82f6', strokeWidth: 2, r: 4 }}
                            activeDot={{ r: 6, strokeWidth: 0 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-sm font-bold text-slate-900 mb-6 uppercase tracking-wider">Agent Utilization</h3>
                    <div className="space-y-6">
                      {agents.slice(0, 5).map((a, i) => (
                        <div key={i} className="space-y-2">
                          <div className="flex justify-between text-xs font-semibold">
                            <span>{a.name}</span>
                            <span className="text-slate-400">{Math.floor(Math.random() * 40 + 60)}%</span>
                          </div>
                          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-blue-500 rounded-full" 
                              style={{ width: `${Math.random() * 40 + 60}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'AGENTS' && (
              <motion.div 
                key="agents"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm"
              >
                <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                  <h3 className="font-bold text-slate-900 uppercase tracking-widest text-xs">Agent Directory ({agents.length})</h3>
                  <button 
                    onClick={() => setShowAddAgent(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition-colors shadow-lg shadow-blue-100"
                  >
                    <Plus size={16} />
                    New Agent
                  </button>
                </div>
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th className="px-6 py-4">Agent</th>
                      <th className="px-6 py-4">ID</th>
                      <th className="px-6 py-4">Status</th>
                      <th className="px-6 py-4">Performance</th>
                      <th className="px-6 py-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {agents.map((agent, i) => (
                      <tr key={i} className="hover:bg-slate-50 transition-colors group">
                        <td className="px-6 py-4 flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center font-bold text-blue-600 text-xs">
                            {agent.name?.[0].toUpperCase()}
                          </div>
                          <span className="font-semibold text-sm">{agent.name}</span>
                        </td>
                        <td className="px-6 py-4 font-mono text-[10px] text-slate-500">{agent.id}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                            agent.status === 'available' ? 'bg-green-50 text-green-700 border-green-100' : 
                            agent.status === 'busy' ? 'bg-orange-50 text-orange-700 border-orange-100' :
                            'bg-slate-50 text-slate-500 border-slate-100'
                          }`}>
                            {agent.status || 'OFFLINE'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex gap-1">
                            {[1,2,3,4,5].map(s => (
                              <div key={s} className={`w-1.5 h-1.5 rounded-full ${s <= (Math.floor(Math.random() * 2) + 3) ? 'bg-blue-500' : 'bg-slate-200'}`} />
                            ))}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                           <div className="flex justify-end gap-2  opacity-0 group-hover:opacity-100 transition-opacity">
                             <button className="p-2 text-slate-400 hover:text-blue-600 transition-colors" title="Edit Script">
                              <Settings size={16} />
                            </button>
                            <button 
                              onClick={() => deleteAgent(agent.id)}
                              className="p-2 text-slate-400 hover:text-red-600 transition-colors" 
                              title="Delete Agent"
                            >
                              <LogOut size={16} className="rotate-180" />
                            </button>
                           </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
            )}

            {activeTab === 'CALLS' && (
              <motion.div 
                key="calls"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="grid grid-cols-1 gap-6"
              >
                {calls.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-20 bg-white rounded-2xl border border-dashed border-slate-300 text-slate-400 space-y-4 shadow-sm">
                    <Phone size={48} className="opacity-20" />
                    <p className="font-medium text-lg">No active calls in the system right now.</p>
                  </div>
                ) : (
                  calls.map((call, i) => (
                    <div key={i} className="bg-white rounded-2xl border border-slate-200 p-6 flex items-center gap-8 shadow-sm hover:border-blue-300 transition-all group">
                      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border ${
                         call.status === 'ACTIVE' ? 'bg-green-50 text-green-600 border-green-100' : 
                         call.status === 'HOLD' ? 'bg-red-50 text-red-600 border-red-100' :
                         'bg-orange-50 text-orange-600 border-orange-100'
                      }`}>
                        <Phone size={24} />
                      </div>
                      <div className="flex-1 grid grid-cols-3 gap-8">
                        <div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase mb-1 tracking-widest">Customer</div>
                          <div className="font-bold text-slate-900">{call.customerName}</div>
                          <div className="text-xs text-slate-400 font-mono italic">{call.callSid.substring(0, 14)}...</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase mb-1 tracking-widest">Current Status</div>
                          <div className="flex items-center gap-2">
                             <div className={`w-2 h-2 rounded-full ${
                               call.status === 'ACTIVE' ? 'bg-green-500 animate-pulse' :
                               call.status === 'HOLD' ? 'bg-red-500' :
                               'bg-orange-500 animate-bounce'
                             }`} />
                             <span className="font-bold text-sm tracking-tight">{call.status}</span>
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase mb-1 tracking-widest">Assigned Agent</div>
                          <div className="font-bold text-sm text-slate-600">{call.assignedAgent || 'WAITING...'}</div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => joinMonitor(call.callSid)}
                          className="flex items-center gap-2 px-5 py-2.5 border border-slate-200 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors shadow-sm"
                        >
                          <Play size={14} />
                          Silent Listen
                        </button>
                        <button className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 shadow-lg shadow-blue-100 transition-all">
                          <Users size={14} />
                          Barge-In
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </motion.div>
            )}

            {activeTab === 'LOGS' && (
              <motion.div 
                key="logs"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="bg-white rounded-2xl border border-slate-200 overflow-hidden"
              >
                <div className="p-6 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                  <h3 className="font-bold text-slate-900 text-xs tracking-widest uppercase">System Audit Stream</h3>
                  <div className="flex gap-2">
                    <div className="h-8 w-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-400 cursor-pointer">
                      <BarChart3 size={16} />
                    </div>
                  </div>
                </div>
                <div className="p-4 space-y-3 max-h-[600px] overflow-y-auto">
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-4 p-4 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                        <div className="text-[10px] font-mono text-slate-400 whitespace-nowrap pt-1">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </div>
                        <div className="space-y-1">
                          <div className="text-[11px] font-bold tracking-wider text-slate-900 uppercase">{log.type}</div>
                          <div className="text-xs text-slate-500 leading-relaxed">{log.message}</div>
                        </div>
                        {log.agentId && (
                           <div className="ml-auto flex items-center gap-2 bg-slate-100 px-3 py-1 rounded-full h-fit self-center">
                             <div className="w-4 h-4 bg-blue-500 rounded-full" />
                             <span className="text-[9px] font-bold text-slate-600">{log.agentId}</span>
                           </div>
                        )}
                      </div>
                    ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function NavItem({ 
  icon: Icon, 
  label, 
  active, 
  onClick, 
  variant = 'primary' 
}: { 
  icon: any, 
  label: string, 
  active?: boolean, 
  onClick: () => void,
  variant?: 'primary' | 'secondary'
}) {
  return (
    <button 
      onClick={onClick}
      className={`
        w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group
        ${active 
          ? 'bg-blue-600 text-white shadow-lg shadow-blue-100' 
          : variant === 'primary' 
            ? 'text-slate-500 hover:bg-slate-100' 
            : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'
        }
      `}
    >
      <Icon size={20} className={active ? 'text-white' : 'text-slate-400 group-hover:text-blue-500'} />
      <span className="font-semibold text-sm tracking-tight">{label}</span>
      {active && (
        <motion.div 
          layoutId="nav-active"
          className="ml-auto w-1.5 h-1.5 rounded-full bg-white"
        />
      )}
    </button>
  );
}
