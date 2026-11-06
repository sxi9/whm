// Icons and tile colours for the panel nav groups. Imported by name so the
// bundle carries only what the panel nav uses (same rule as client/src/icons.js).
import {
  LayoutDashboard, Globe, Network, Lock, FolderOpen, Mail, Database, HardDriveUpload, Clock, Archive, ScrollText, Code, Shield, Gauge, Wrench, Package, Settings, Circle,
} from 'lucide-react';

export const PANEL_ICONS = { LayoutDashboard, Globe, Network, Lock, FolderOpen, Mail, Database, HardDriveUpload, Clock, Archive, ScrollText, Code, Shield, Gauge, Wrench, Package, Settings };

export function panelIconFor(name) {
  return PANEL_ICONS[name] || Circle;
}

// One system colour per group, applied through --tile on .nav-tile (design system §5).
const GROUP_COLORS = {
  overview: '#0a84ff', domains: '#32ade6', dns: '#30b0c7', ssl: '#34c759', files: '#ff9f0a', email: '#007aff',
  databases: '#ff9500', ftp: '#5e5ce6', cron: '#8e8e93', backups: '#5856d6', logs: '#636366', php: '#af52de',
  security: '#ff3b30', usage: '#ff2d55', advanced: '#48484a', software: '#21759b', preferences: '#a2845e',
};

export function panelColorFor(slug) {
  return GROUP_COLORS[slug] || '#8e8e93';
}
