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
