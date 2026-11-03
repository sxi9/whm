// Explicit icon map so the bundle only carries the icons the navigation uses
// (importing * from lucide-react would ship the whole set).
import {
  Settings, LifeBuoy, Network, Shield, Contact, Users, Server, Languages, Archive, Share2, Power, Activity,
  UserSearch, UserCog, UsersRound, ArrowLeftRight, Palette, Package, Globe, Database, Wifi, Wrench, Mail,
  HeartPulse, LayoutDashboard, Lock, Store, RotateCw, Code, Puzzle, Circle,
} from 'lucide-react';

export const CATEGORY_ICONS = {
  Settings, LifeBuoy, Network, Shield, Contact, Users, Server, Languages, Archive, Share2, Power, Activity,
  UserSearch, UserCog, UsersRound, ArrowLeftRight, Palette, Package, Globe, Database, Wifi, Wrench, Mail,
  HeartPulse, LayoutDashboard, Lock, Store, RotateCw, Code, Puzzle,
};

export function iconFor(name) {
  return CATEGORY_ICONS[name] || Circle;
}

// One system colour per category, used for the sidebar and dashboard icon tiles.
const CATEGORY_COLORS = {
  'server-configuration': '#8e8e93', support: '#ff9500', 'networking-setup': '#30b0c7', 'security-center': '#ff3b30',
  'server-contacts': '#34c759', resellers: '#5856d6', 'service-configuration': '#636366', locales: '#af52de',
  backup: '#007aff', clusters: '#5ac8fa', 'system-reboot': '#ff2d55', 'server-status': '#34c759',
  'account-information': '#0a84ff', 'account-functions': '#007aff', 'multi-account-functions': '#5e5ce6',
  transfers: '#ff9f0a', themes: '#bf5af2', packages: '#a2845e', 'dns-functions': '#32ade6', 'database-services': '#ff9500',
  'ip-functions': '#64d2ff', 'software': '#636366', email: '#007aff', 'system-health': '#ff2d55', cpanel: '#0a7aff',
  'ssl-tls': '#34c759', market: '#ff6482', 'restart-services': '#ff9500', development: '#8e8e93', plugins: '#af52de',
};

export function colorFor(slug) {
  return CATEGORY_COLORS[slug] || '#8e8e93';
}
