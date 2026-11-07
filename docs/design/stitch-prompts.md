# Keel — Google Stitch prompt pack

Every screen in Keel, written as a prompt you can paste into Google Stitch. Generated from the
navigation tables and the page components in `client/src`, so the content described here is what the
product actually shows today.

| | Count |
|---|---|
| Shell and auth screens | 13 |
| Page patterns | 10 |
| Admin panel screens | 212 |
| Account panel screens | 64 |
| Sub-screens (dialogs, confirmations, wizard steps, drawers) | see each screen |

---

## How to use this pack

1. **Start a Stitch project in Web mode.** Keel is a desktop-first product; the phone layout is a
   variation, not the primary design.
2. **Paste section 1 (the style prompt) as your first prompt.** Stitch carries project context
   forward, so later screens inherit it. If a screen drifts off-style, paste the short style
   reminder at the end of section 1 together with that screen's prompt.
3. **Design the patterns in section 3 before the individual screens.** Ten patterns cover all 276
   function screens. Once a pattern looks right, the per-screen prompts in sections 4 and 5 are
   mostly a matter of swapping the content.
4. **Then work through sections 4 and 5.** Each screen has one main prompt and, under it, a prompt
   per sub-screen. Generate the main screen first, then send each sub-screen prompt as a follow-up
   in the same Stitch thread so the dialog matches the screen behind it.
5. **Two shells, one design system.** The admin panel is used by the server operator; the account
   panel is used by a hosting customer. They share the shell, the components and the tokens. Keep
   them visually identical apart from the content.

Prompts describe content and layout only. Colour, type and shape come from section 1, which is why
the per-screen prompts never mention them.

---

## 1. Global style prompt

Paste this once, at the start of the project.

```text
Design system for Keel, a self-hosted web hosting control panel used by server
administrators and hosting customers. Visual language: Apple macOS and iOS system UI.
System typography, grouped inset surfaces, hairline separators, tinted controls, exactly
one accent colour, restrained motion. Dense, calm, professional. No illustrations, no
gradients, no glassmorphism except the translucent top bar and sidebar, no rounded
cartoon shapes, no emoji.

Light theme: page background #f2f2f7, card surface #ffffff, secondary surface #f6f6f9,
hairline border rgba(60,60,67,0.14), text #1c1c1e, muted text rgba(60,60,67,0.62).
Dark theme: page background #000000, card surface #1c1c1e, secondary surface #2c2c2e,
border rgba(84,84,88,0.55), text #f2f2f7, muted text rgba(235,235,245,0.62).
Accent blue #0a7aff in light and #0a84ff in dark, and it is the only brand colour in
controls. Status colours: success #34c759, warning #ff9500, danger #ff3b30, info blue.
Each status also has a soft 12 to 18 percent tint used behind pills and banners.

Typography: SF Pro Text and SF Pro Display, falling back to Segoe UI Variable and Inter.
Page title 28px weight 700 with tight tracking. Card title 17px weight 600. Body 14px.
Secondary text 13.5px muted. Captions 12.5px. Numbers are tabular. Sentence case
everywhere, never uppercase labels, never letter-spaced small caps.

Shape and depth: cards 14px radius, controls and inputs 10px radius, sheets and modals
20px radius. Shadows are almost invisible on cards, 0 1px 2px rgba(0,0,0,0.04); modals
and popovers get one large soft shadow. Separators inside a card are hairlines, never a
box inside a box.

Controls: text inputs are filled grey fields, rgba(120,120,128,0.12), with no border
until focus and then a 2px accent ring. Buttons come in grey fill, solid blue primary,
solid red destructive, and tinted-text ghost. Switches are iOS-style toggles, green when
on. Segmented controls for exclusive choices. Status pills are small capsules on a soft
tint. Icons are Lucide line icons at 14 to 20px; category icons sit on a 28px rounded
square tile filled with that category's colour, icon in white.

Layout: fixed left sidebar 276px wide and translucent, top bar 56px and translucent,
content column centred with a 1320px maximum and 24 to 32px padding. Default canvas is
1440 by 960 desktop unless the prompt says phone.
```

**Short reminder** — append to any screen that drifts:

```text
Keep the Keel style: Apple system UI, #f2f2f7 page, white cards with 14px radius and
hairline borders, single #0a7aff accent, filled borderless inputs, Lucide line icons,
sentence case, tabular numbers, no gradients.
```

---

## 2. Shell and authentication screens

These 13 screens define the frame every other screen sits in. Design them first.

### 2.1 Admin sidebar

```text
Desktop admin panel, left sidebar only, 276px wide, full height, translucent light grey.
Top: product mark, a blue rounded square with a white 'K', next to 'Keel' and the
subtitle 'Hosting control panel'. Below it a filled search field with a magnifier icon
and placeholder 'Search', then a row of two small ghost links, 'Expand all' and
'Collapse all'. Then the navigation: a 'Home' row with a house icon, a 'Favorites'
group with an orange star tile and a count, then 30 collapsible category groups. Each
group header is a 28px rounded tile in the category colour with a white Lucide icon, the
category name, a muted count on the right, and a chevron. One group is expanded showing
its child links as plain indented rows, the active one filled with blue. A 'Collapse
sidebar' icon button sits at the bottom.
```

### 2.2 Admin top bar

```text
Desktop admin panel, top bar only, 56px tall, translucent with a hairline bottom border.
Left: a hamburger icon button, then the product mark. Centre: a wide filled search field
with a magnifier icon, placeholder 'Search functions' and a small keyboard hint chip
reading 'Alt /' on the right inside the field. Right side: a grey monospace chip showing
the server hostname 'nova.hostingsignal.in', an audit-log scroll icon button, a bell icon
button, then a user button with a blue circular avatar holding the initial 'K', the name
'keel-ops' and a chevron. Show the search dropdown open below the field with four result
rows, each a function name on the left and its muted category on the right.
```

### 2.3 Admin home dashboard

```text
Desktop admin panel home, 1440px, sidebar and top bar in place. Two columns. Left column:
a hero line 'Good evening, keel-ops' as a 28px title with a muted subline
'nova.hostingsignal.in · 2 accounts · load 0.08'. Then a card titled 'Favorites' with the
subtitle 'Your pinned tools' and a collapse chevron. Then a card titled 'Tools' whose
header carries 'Expand all', 'Collapse all' and a small filled filter field with
placeholder 'Filter tools…'. Inside it, collapsible sections, one per category: a header
row with the coloured category tile, the category name, a count and a chevron, and under
it a grid of tool cards three across. Each tool card is a white rounded rectangle holding
a 38px coloured icon tile, a 15px bold title and a 13px muted one-line description.
Right column, 380px: a card titled 'Statistics' with a 'Refresh' link and a key/value
list of Hostname, Main IP, Load averages, Uptime, Operating system, Kernel, CPU, Memory,
Disk, Accounts, Resellers, Panel version and License with a green status pill. Below it a
card titled 'Service status' with the subtitle 'Monitored services' and a 'Details' link.
```

### 2.4 Login

```text
Centred sign-in card on a plain light background, 1440px canvas. The card is white,
400px wide, 20px radius, with a soft shadow. Inside, centred: a 56px blue rounded-square
mark with a white 'K', the muted line 'Keel · Hosting control panel', then the heading
'Sign in' at 22px weight 700. Below it a 'Username' label with a filled input, a
'Password' label with a filled input, and a full-width solid blue 'Sign in' button. Under
the button a small blue link 'Forgot password?'. Nothing else on the page.
```

### 2.5 Two-factor step

```text
The same centred sign-in card, now headed 'Two-factor authentication'. One field labelled
'Verification code' with a filled input and the helper line 'Enter the 6-digit code from
your authenticator app.', a full-width solid blue 'Verify' button, and a small ghost
'Back' link under it. Show a variant with a red error banner above the field reading
'Invalid verification code'.
```

### 2.6 Password reset request

```text
The same centred card, headed 'Reset your password', with the explanatory line 'Enter
your username and we will email you a link to set a new password.', one filled input
labelled 'Username', and a full-width solid blue 'Send reset link' button with a 'Back to
sign in' link under it. Also draw the success state: the form replaced by a blue
information banner reading 'If that account exists, a reset link is on its way.'
```

### 2.7 Password reset confirm

```text
The same centred card, headed 'Choose a new password', with two filled inputs labelled
'New password' and 'Confirm password', a short password-rules helper line under the
first, and a full-width solid blue 'Set password' button. Draw a second version showing a
red banner reading 'This reset link has expired.' with a 'Request a new link' button.
```

### 2.8 Change password

```text
Desktop admin panel screen, 1440px. Page header 'Change password' with the description
'Update the password for your own panel account.' One narrow white card holding three
filled inputs labelled 'Current password', 'New password' and 'Confirm new password',
each with a show/hide eye button, a password-strength helper line, and a footer row with
a solid blue 'Change password' button and a grey 'Cancel' button.
```

### 2.9 Audit log

```text
Desktop admin panel screen, 1440px. Page header 'Audit log' with the description
'Every action taken through the panel.' Header action: a grey 'Export' button. One white
card with no padding holding a filter row of three filled fields, 'Search', 'Action' and
'User', then a table with columns Time, User, Action, Target, Details and IP. Times are
tabular, actions are shown as small grey code chips, and the Details column shows a
truncated value with a muted ellipsis. A footer row shows '1–50 of 1,284' with previous
and next buttons.
```

### 2.10 Not found, admin

```text
Desktop admin panel screen, 1440px, sidebar and top bar in place, the content column
holding a centred empty state: a 40px muted Lucide compass icon, the 20px title 'That
page does not exist', a muted line 'Check the address, or pick a tool from the sidebar.',
and a solid blue 'Go to the dashboard' button.
```

### 2.11 Account panel home

```text
Desktop account panel home, 1440px, same shell. A blue information bar across the top of
the content reading 'Viewing leakwatch as keel-ops · ends in 60 min' with an eye icon and
a grey 'Exit' button on the right. Then a 28px title 'Good evening, leakwatch' with the
muted subline 'leakwatch.hostingsignal.in · default plan · on nova.hostingsignal.in' and
an 'Account details' button on the right, then a small grey 'Webmail' button with an
external-link icon. Two columns. Left: a card titled 'Usage' with the subtitle 'Disk
measured 6/11/2026, 5:55 pm' and a grid of seven meter tiles, each a muted label, a large
value such as '7.71 GB · unlimited' or '0 of 50', and a thin progress bar. Below it a
card titled 'Tools' with 'Expand all', 'Collapse all' and a filter field, holding
collapsible category sections of tool cards. Right column: a card titled 'Domains' with a
'Manage' link listing the main domain with a green 'Main' pill and its document root, and
under it a card titled 'Account' with a key/value list of Username, Main domain, IP
address, Plan, Server and Status with a green 'Active' pill.
```

### 2.12 Account panel sidebar

```text
Desktop account panel, left sidebar only, 276px wide. Same structure as the admin
sidebar: product mark, filled 'Search' field, 'Expand all' and 'Collapse all', a 'Home'
row shown active and filled blue, then 17 collapsible category groups, each with its
coloured rounded icon tile, name and count: Overview 3, Domains 5, DNS 3, SSL 3, Files 6,
Email 12, Databases 5, FTP 1, Cron 1, Backups 2, Logs 4, PHP 2, Security 6, Usage 1,
Advanced 4, Software 4, Preferences 1.
```

### 2.13 Phone layout

```text
Phone screen, 390 by 844, of the account panel home. The sidebar is gone; the top bar
shows a hamburger button, the product mark, a search icon and the avatar. The content
stacks in one column: the greeting, the usage meters one per row, then the tools
sections. Nothing scrolls sideways. Draw a second frame with the navigation drawer open
over a dimmed page, sliding in from the left at 300px wide with a close button.
```

---

## 3. The ten page patterns

Design these once. Every screen in sections 4 and 5 is one of them with different content.

### 3.1 Data-table page

```text
Desktop admin panel screen, 1440px. Page header with breadcrumb, 28px title, favourite
star outline, one muted description line, and one solid blue primary button on the right.
Body: a single white card with no inner padding. Its header row holds a filled search
field on the left and two ghost buttons on the right. Then a table: hairline-separated
rows, 13.5px muted column headers with sort chevrons, tabular numbers, a status pill
column, and a trailing column with a '...' icon button. A footer row inside the card
shows '1–25 of 142' with previous and next buttons. Show one row's '...' menu open as a
floating rounded panel with five items, the last one in red.
```

### 3.2 Form page

```text
Desktop admin panel screen, 1440px. Page header with breadcrumb, title and description.
Body: one white card titled with the section name, holding a two-column grid of fields.
Each field is a 13.5px label, a filled borderless input, and a 12.5px muted helper line
under it. Include one select with a chevron, one iOS toggle with its label on the left
and the switch on the right, and one field showing a red inline error message and a red
focus ring. The card ends with a hairline and a right-aligned footer holding a grey
'Cancel' button and a solid blue 'Save' button.
```

### 3.3 Settings page

```text
Desktop admin panel screen, 1440px. Page header with title and description, and a grey
'Reset to defaults' button on the right. Body: three stacked white cards, each with a
title and subtitle. Inside each card, settings are rows separated by hairlines: on the
left a 14px label and a 12.5px muted explanation, on the right the control, either an iOS
toggle, a short filled input, or a segmented control. A sticky footer bar at the bottom
of the content column, translucent, shows 'You have unsaved changes' on the left and
'Discard' and solid blue 'Save changes' buttons on the right.
```

### 3.4 Action page

```text
Desktop admin panel screen, 1440px. Page header with title and description. Body: one
narrow white card, 720px wide, holding a short explanatory paragraph, two or three
fields, and a footer with a single solid blue action button. Under it a second white card
titled 'Result', currently showing a centred empty state: a muted Lucide icon, the line
'Nothing has run yet', and a smaller muted sentence explaining what will appear here.
```

### 3.5 Statistics page

```text
Desktop admin panel screen, 1440px. Page header with title, description and a 'Refresh'
ghost button. Body: a grid of six stat tiles, each a white card with a 12.5px muted
label, a 28px tabular value, and a thin progress meter under it where a limit applies.
Below the grid, two white cards side by side: one holding a key/value list of a dozen
facts with the values right-aligned and tabular, the other holding a simple line chart
over a hairline grid in the accent blue, with a muted axis and no legend chrome.
```

### 3.6 Wizard

```text
Desktop admin panel screen, 1440px. Page header with title and description. Under it a
horizontal stepper with four steps: a numbered circle, a label, and a hairline connector;
step two is current and filled blue, step one is complete with a check, steps three and
four are muted. Body: one white card holding the current step's fields, and a footer with
a grey 'Back' button on the left and a solid blue 'Continue' button on the right. Show a
muted line above the footer reading 'Step 2 of 4'.
```

### 3.7 Progress and log page

```text
Desktop admin panel screen, 1440px. Page header with title and description. Body: a white
card titled 'Progress' holding a thin determinate progress bar at 60 percent, a line
reading 'Building PHP 8.5.12 · step 4 of 7', and a grey 'Cancel' button. Under it a dark
log panel, near-black background with light grey monospace 12.5px text, 14px radius,
showing twenty lines of build output with timestamps, the newest at the bottom, and a
small 'Copy' ghost button floating in its top-right corner.
```

### 3.8 File explorer

```text
Desktop account panel screen, 1440px. Page header 'File manager' with a row of header
buttons. Body: one white card split in two. A 260px left pane holds a folder tree with
disclosure triangles and folder icons, the selected folder filled blue. The right pane
holds a path breadcrumb with a 'Go' button, a toolbar of small buttons, and a table of
files with columns Name with a file-type icon, Size, Type, Last modified and Permissions,
plus a leading checkbox column and a trailing '...' menu. The footer of the card shows
'24 items · 3 selected'.
```

### 3.9 Catalog page

```text
Desktop account panel screen, 1440px. Page header 'Installers' with a description. Body:
a filled search field, then a grid of catalogue cards three across. Each card is white
with a 48px application logo on a tinted rounded square, a 17px name, a 13.5px muted
description of two lines, a small grey version chip, and a solid blue 'Install' button at
the bottom. One card shows an 'Installed' state instead: a green check pill and a grey
'Manage' button.
```

### 3.10 Viewer page

```text
Desktop admin panel screen, 1440px. Page header with title, description, and 'Download'
and 'Refresh' buttons. Body: a white card whose header holds a filled filter field and a
segmented control with three options, and whose body is a dark monospace panel filling
the rest of the screen with wrapped log lines, muted timestamps, and the matching text
highlighted in a soft yellow tint.
```

### 3.11 Shared states

Generate these once each; they repeat across every screen.

```text
Four small frames on one canvas, in the Keel style. One: an empty state inside a white
card, a 40px muted Lucide icon, a 17px title, a 13.5px muted sentence and a small solid
blue button. Two: a loading state, three grey skeleton rows of different widths with
rounded ends. Three: four banners stacked, info blue, success green, warning orange and
danger red, each a soft tinted rounded rectangle with a matching Lucide icon on the left,
bold first sentence and muted second sentence. Four: a toast, a white rounded pill with a
large soft shadow in the bottom-right corner, holding a green check icon and one line of
text.
```

```text
Two modal dialogs on one canvas over a dimmed page. One is a confirmation: 320px wide,
20px radius, a 17px bold title, a 13.5px muted paragraph, and a footer with a grey
'Cancel' button and a solid red confirm button. The other is a form dialog: 520px wide,
a title, three filled fields with labels, a hairline above the footer, and a grey
'Cancel' plus a solid blue 'Create' button.
```

---

## 4. Admin panel — 212 screens

Port 2087. The reader is the server operator. Every screen below sits in the shell from section 2.1 to 2.3.

### 1. Server Configuration

13 screens. Sidebar tile colour for this category is used on its tool cards.

#### Basic Setup

`/server-configuration/basic-webhost-manager-setup` · config

```text
Desktop admin panel screen, 1440px. Page header 'Basic Setup', breadcrumb Home > Server Configuration > Basic Setup, favourite star, description 'Contact details, main and shared IPs, nameservers and account defaults.' No header action buttons. Directly under the header a two-tab strip, 'Settings' and 'License', with 'Settings' selected. Body: three stacked setting cards. 'Contact information' holds one filled input 'Server contact email address' with helper text 'Receives alerts, reports and license notices.' 'Basic configuration' holds filled inputs 'Hostname', 'Main server IP address', 'Shared virtual host IP address', 'Home directory root' and 'Default package', each with a line of helper text. 'Nameservers', subtitled 'Nameservers written into every new DNS zone.', holds a multi-line list box 'Nameservers' with placeholder 'ns1.example.com, ns2.example.com'. A sticky bar pinned to the bottom of the page holds 'Save' and 'Reset', both greyed out until something changes.
```

Sub-screens (5):

- **License tab**

  ```text
  Drill-down view of the same screen with the 'License' tab selected and description 'Activate, replace or check in the license for this server. The key is entered only here.' Cards: 'License' with a 'Check in now' button and key/value rows 'Status', 'Edition', 'Key', 'License expires', 'Token valid until', 'Activation', 'Hub', 'Last check-in', 'Next check-in', 'Enforcement'; 'Edition limits and features'; 'Activate with a license key' with input 'License key' and button 'Activate'; 'Activations' table; 'Start a free trial'; 'Recent license events' table.
  ```

- **Activations table on the License tab**

  ```text
  Drill-down view of the 'Activations' card, subtitled with how many servers the license allows. Table columns 'Activation', 'Hostname', 'Last check-in', 'Status'. The current row is tagged 'this server' and carries a red 'Deactivate this server' button; other rows carry 'Transfer here'.
  ```

- **Start a free trial card**

  ```text
  Drill-down view of the card 'Start a free trial', subtitled '14 days, 5 hosting accounts, one trial per server and email address. The trial converts to a paid edition without re-activation.' One filled input 'Email address' with placeholder 'ops@example.com' and a 'Start trial' button.
  ```

- **All activations are in use modal**

  ```text
  Modal dialog titled 'All activations are in use', explaining that the license has no free activation and that transferring a server puts the other one into read-only mode at its next check-in. A table with columns 'Activation', 'Hostname', 'Last check-in' and a 'Transfer here' button per row. Footer button 'Close'.
  ```

- **Deactivate this server confirmation**

  ```text
  Confirmation dialog titled 'Deactivate this server?' with the message that the activation is released for another server, the panel becomes read-only here until a key is activated again, and sites keep running. Buttons 'Deactivate' in red and 'Cancel'.
  ```

#### Change Root Password

`/server-configuration/change-root-password` · form

```text
Desktop admin panel screen, 1440px. Page header 'Change Root Password', breadcrumb Home > Server Configuration > Change Root Password, favourite star, description "Changes the operating system's root password used for SSH and console access. Your panel login password is separate." No header action buttons. Body: a single card. At the top a muted line 'Looking for your panel login password?' with a link 'Change panel password'. Below it a narrow form holding a password field 'New root password' with a strength meter, and a second masked field 'Confirm new password', both marked required, and a primary button 'Change root password'. Error states to draw: an inline error banner above the fields reading 'Passwords do not match', and another reading 'Choose a stronger password (minimum strength 65)'.
```

Sub-screens (1):

- **Change the server root password confirmation**

  ```text
  Confirmation dialog titled 'Change the server root password?' with the message that this changes the Linux root account used for SSH and console access and that the new password should be recorded. Buttons 'Change' in red and 'Cancel'.
  ```

#### Configure Analytics

`/server-configuration/configure-cpanel-analytics` · config

```text
Desktop admin panel screen, 1440px. Page header 'Configure Analytics', breadcrumb Home > Server Configuration > Configure Analytics, favourite star, description 'Interface analytics help improve the panel by reporting which functions are used. Participation is optional, anonymous and off by default.' No header action buttons. Body: a full-width card 'Participation' with three switch rows, each with a label and a line of explanation: 'Send anonymous interface analytics', 'Include feature usage' and 'Include anonymous error signatures', the last two greyed out while the first is off, then buttons 'Save' and 'Reset'. Below it two side-by-side cards: 'Identity' with a small 'Rotate ID' button in its corner and key/value rows 'Status', 'Participant ID' and 'Last changed'; and 'What is collected' with a bullet list and a closing line beginning 'Never collected:'.
```

Sub-screens (1):

- **Rotate the participant ID confirmation**

  ```text
  Confirmation dialog titled 'Rotate the participant ID?' with the message 'Previously submitted analytics can no longer be linked to this server.' Buttons 'Rotate' and 'Cancel'.
  ```

#### Configure Panel Cron Jobs

`/server-configuration/configure-cpanel-cron-jobs` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Configure Panel Cron Jobs', breadcrumb Home > Server Configuration > Configure Panel Cron Jobs, favourite star, description "The panel's own maintenance schedules: backups, AutoSSL renewals, bandwidth accounting, quota checks and cleanup. Each runs as a background job you can follow in Task Queue Monitor." No header action buttons. Body: one borderless card holding a table with columns 'Schedule' (the schedule name with its job type in monospace underneath), 'Cron expression' (a narrow monospace input with a small 'Save' button beside it, the button greyed out until the text changes), 'Enabled' (a switch), 'Last run' and 'Next run'. Empty state: 'No schedules registered yet', explaining each schedule appears here with its cron expression, switch and last and next run as its feature is enabled.
```

#### Initial Quota Setup

`/server-configuration/initial-quota-setup` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Initial Quota Setup', breadcrumb Home > Server Configuration > Initial Quota Setup, favourite star, description 'Disk quotas let packages limit how much space each account may use. This checks the filesystem that holds account home directories, enables user quotas where the mount allows it and otherwise shows the exact /etc/fstab change required.' Body: two side-by-side cards. 'Summary', with a last-job pill in its corner, lists 'Account homes', 'Filesystem holding homes', 'User quotas on that filesystem', 'Quota tools (quotacheck, quotaon, quotaoff, repquota, setquota)' and 'Package disk limits enforceable', each value a small status pill, plus a warning notice with an 'Install quota tools' button when the tools are missing. 'Options' holds the switch 'Also enable group quotas' and an explanatory paragraph. Below, a full-width card 'Filesystems' with a table of columns 'Mount point', 'User quota', 'Mounted with quota option', '/etc/fstab' and 'Quota files', each row with a '...' menu holding 'Enable quotas', 'Update fstab and enable' and 'Turn off'. Status pills: 'active', 'off', 'unsupported', 'ready' with 'quotaon needed' beneath, 'not configured', and an 'homes' tag. A last card 'Required /etc/fstab change' shows a monospace diff block.
```

Sub-screens (4):

- **Enable quotas confirmation**

  ```text
  Confirmation dialog titled 'Enable quotas on /home?' explaining that quotacheck scans every file on the mount point to build the quota files, then quotaon turns quotas on, and that the scan can take a long time on large disks. Buttons 'Enable quotas' and 'Cancel'.
  ```

- **Update fstab and enable confirmation**

  ```text
  Confirmation dialog titled 'Enable quotas on /home?' in a danger style, explaining that the /etc/fstab line is rewritten with a backup kept as /etc/fstab.whm-bak, the filesystem is remounted with the quota options, then quotacheck scans every file before quotaon turns quotas on. Buttons 'Enable quotas' in red and 'Cancel'.
  ```

- **Turn quotas off confirmation**

  ```text
  Confirmation dialog titled 'Turn quotas off on /home?' with the message that accounts keep their limits in the panel but the kernel stops enforcing them until quotas are turned on again. Buttons 'Turn off' in red and 'Cancel'.
  ```

- **Quota setup job card**

  ```text
  Alternate state: a card 'Quota setup' appears between the summary and the filesystems table, holding a live progress bar and a scrolling monospace log of the running background job, replaced by a finished result when the job ends.
  ```

#### Link Server Nodes

`/server-configuration/link-server-nodes` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Link Server Nodes', breadcrumb Home > Server Configuration > Link Server Nodes, favourite star, description 'Register other panel servers this one can hand work to: DNS cluster members, remote mail or database nodes and backup targets. Each link stores an API token for the remote panel; Test connection calls its status endpoint.' Header action: a primary button 'Link a server node'. Body: a card 'Linked nodes' subtitled with the node count, holding a table with columns 'Node' (name with the scheme, host, port and username underneath), 'Roles' (small pills), 'Connection' (pill reading reachable, failed or untested), 'Remote panel', 'Last tested' and 'Token' (pill reading stored or missing). Each row has a '...' menu with 'Test connection', 'Edit' and 'Unlink'. Empty state: 'No linked nodes yet. Linked servers appear here with their roles and connection state.' After a test, a card 'Last test: <node>' shows the raw response in a monospace block or an error banner.
```

Sub-screens (3):

- **Link a server node modal**

  ```text
  Large modal dialog titled 'Link a server node'. Two-column fields 'Name', 'Hostname or IP', 'Scheme', 'Port', 'Remote username' and 'API token'. Below, a full-width group 'Roles this node serves' with checkboxes 'DNS', 'Mail', 'Database', 'Web' and 'Backup', then switches 'Verify the TLS certificate' and 'Enabled'. Buttons 'Link node' and 'Cancel'.
  ```

- **Edit node modal**

  ```text
  Large modal dialog titled 'Edit dns-node-2' with the same fields filled in, the token field relabelled 'New API token (leave empty to keep)' and no longer required. Buttons 'Save changes' and 'Cancel'.
  ```

- **Unlink node confirmation**

  ```text
  Confirmation dialog titled 'Unlink dns-node-2?' with the message 'The stored token is deleted. Nothing changes on the remote server.' Buttons 'Unlink' in red and 'Cancel'.
  ```

#### Server Profile

`/server-configuration/server-profile` · config

```text
Desktop admin panel screen, 1440px. Page header 'Server Profile', breadcrumb Home > Server Configuration > Server Profile, favourite star, description 'A profile declares which roles this server fulfils. It drives which services are monitored and what linked nodes and integrations expect from it, and it publishes the list of categories that do not apply to this role. It never installs or removes software.' Body: a card 'Profile', subtitled 'Active: <profile name>', holding a stacked radio list where each option shows a profile name and a line of description, then buttons 'Apply profile' and 'Cancel'. Below, two side-by-side cards: 'Monitored services' with a two-column table 'Service' and 'Monitored', each row a service display name with its unit name underneath and a pill reading 'monitored' or 'not monitored'; and 'Categories not applicable to this role', subtitled that these categories are hidden from the sidebar, Tools and search while the profile is active and their pages stay reachable by URL, holding a bullet list of category names, or the line 'Every category applies to this profile.'
```

Sub-screens (2):

- **Switch profile confirmation**

  ```text
  Confirmation dialog titled 'Switch to Mail server?' explaining that service monitoring follows the profile, listing the monitored services, saying how many categories are hidden from the sidebar and search, and ending 'No daemon is stopped or uninstalled.' Buttons 'Apply profile' and 'Cancel'.
  ```

- **Applied result card**

  ```text
  Alternate state: a card 'Applied' added at the bottom reading 'Switched from <previous> to <current>.' followed either by 'No monitoring change was needed.' or by a count of monitoring changes and a bullet list of service names each with an arrow to 'monitored' or 'not monitored'.
  ```

#### Server Time

`/server-configuration/server-time` · config

```text
Desktop admin panel screen, 1440px. Page header 'Server Time', breadcrumb Home > Server Configuration > Server Time, favourite star, description "Set the system timezone and keep the clock synchronised with NTP through systemd's timedatectl. Mail headers, logs and cron use this clock." No header action buttons. Body: two side-by-side cards. 'Current server time' lists key/value rows 'Server clock' with the live time in bold, 'System timezone', 'NTP synchronisation', 'Clock synchronised', 'RTC in local time' and 'NTP service', the last four as small status pills, with a muted note when no NTP daemon is installed. 'Change timezone and NTP' holds a filled input 'Find a timezone' with placeholder 'Berlin, New_York, Tokyo', a dropdown 'Timezone' showing the current UTC offset as helper text, a switch 'Synchronise the clock with NTP', and buttons 'Apply' and 'Reset'. Draw a warning notice at the top of that card for when timedatectl is unavailable and the controls are greyed out.
```

#### Statistics Software Configuration

`/server-configuration/statistics-software-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Statistics Software Configuration', breadcrumb Home > Server Configuration > Statistics Software Configuration, favourite star, description 'Choose which web statistics generators process the per-domain access logs, which one accounts get by default and how often statistics are rebuilt.' Header action: a primary button 'Generate now'. Body: a card 'Generators' with a four-column table 'Generator', 'Installed', 'Enabled' and an action column, rows AWStats, Webalizer and Analog, each with a one-line blurb, an installed or not-installed pill, a switch, and a small 'Run AWStats' style button. Underneath, a dropdown 'Default generator for new accounts', switches 'Let account owners choose their generator' and 'Process suspended accounts too', then 'Save' and 'Reset'. Below, two side-by-side cards: 'Schedule' with a status pill reading enabled, paused or disabled, a switch 'Rebuild statistics on a schedule', a monospace 'Cron expression' field with its own Save button, and rows 'Last run', 'Next run' and 'Active domains'; and 'Last run' with a job pill and rows 'When', 'Generators', 'Domains', 'Generated', 'Skipped (no log yet)' and 'Failed'.
```

Sub-screens (3):

- **Generate statistics now confirmation**

  ```text
  Confirmation dialog titled 'Generate statistics now?' with the message that it runs every enabled generator for all active domains as a background job and that large logs take a while. Buttons 'Generate' and 'Cancel'.
  ```

- **Statistics generation job card**

  ```text
  Alternate state: a card 'Statistics generation' appears at the bottom of the page with a progress bar and a live scrolling monospace log for the running background job.
  ```

- **Empty last run state**

  ```text
  Alternate state of the 'Last run' card showing only the muted line 'Statistics have not been generated yet. The time, generators and domain counts of the last run appear here after the first run.'
  ```

#### Terminal

`/server-configuration/terminal` · action

```text
Desktop admin panel screen, 1440px. Page header 'Terminal', breadcrumb Home > Server Configuration > Terminal, favourite star, description 'A root shell on this server inside the browser. Sessions are audited when opened and closed, belong to the administrator who opened them and expire after a period of inactivity.' Header action: a primary button 'New session'. Body: a card 'Terminal' with a red 'Close session' button in its corner, holding a full-width black terminal emulator with a blinking cursor. Below it a card 'Your sessions', subtitled with how many sessions are allowed at once and after how many idle minutes a session ends, holding a table with columns 'Session' (short monospace id with the PID underneath and an 'attached' pill on the live one), 'Shell', 'Started', 'Last activity', 'Viewers' and an action column with small 'Attach' and red 'Close' buttons. Empty state row: 'No open sessions. Sessions you open appear here with their shell, start time and viewers.' Also draw the warning notice shown when the 'script' utility is missing and 'New session' is greyed out.
```

Sub-screens (1):

- **Close terminal session confirmation**

  ```text
  Confirmation dialog titled 'Close this terminal session?' with the message 'The shell and anything running in the foreground receive SIGHUP.' Buttons 'Close session' in red and 'Cancel'.
  ```

#### Tweak Settings

`/server-configuration/tweak-settings` · config

```text
Desktop admin panel screen, 1440px. Page header 'Tweak Settings', breadcrumb Home > Server Configuration > Tweak Settings, favourite star, description 'Hundreds of server-wide behaviour switches.' No header action buttons. Body: five stacked setting cards. 'Mail' with number field 'Maximum hourly emails per domain' and switch 'Allow remote domains'. 'Accounts' with switch 'Prevent unlimited bandwidth on new accounts' and dropdown 'Login theme'. 'Security' with switch 'cPHulk brute force protection', number fields 'Minimum password strength', 'Failed logins per IP before blocking' and 'Block duration (minutes)', and switch 'Require two-factor authentication for root'. 'System' with 'Default DNS zone TTL (seconds)', text field 'Default PHP version for new accounts' placeholder 'ea-php83', dropdown 'Update tier' offering stable, release and edge, and switches 'Automatic updates' and 'Interface analytics'. 'Backups' with switch 'Enable scheduled backups', text field 'Backup schedule (cron)' placeholder '0 2 * * *' and number fields 'Keep daily backups', 'Keep weekly backups' and 'Keep monthly backups'. A sticky bottom bar holds 'Save' and 'Reset'.
```

#### Update Preferences

`/server-configuration/update-preferences` · config

```text
Desktop admin panel screen, 1440px. Page header 'Update Preferences', breadcrumb Home > Server Configuration > Update Preferences, favourite star, description 'Choose the release tier the panel follows and the update policy. Checks themselves are run by the Software category: the daily OS package check (os-update-check) and the panel release feed. This page records what you want and notifies the server contact.' Header action: a button 'Check for updates now'. Body: a card 'Release tier' holding a stacked radio list of tiers. A card 'Update policy' with three switches, each with a paragraph of explanation: 'Panel updates: apply automatically (recorded policy)', 'Apply operating system package updates automatically' and 'Notify the server contact when updates are available', then 'Save' and 'Reset'. Below, two side-by-side cards: 'Panel' listing 'Installed version', 'Latest on tier', 'Update available' as a pill, 'Install method' and 'Feed checked'; and 'Operating system packages' listing 'Package manager', 'Pending updates', 'Security updates', 'Reboot required', 'Checked', 'Daily check schedule' with its cron in monospace and an enabled pill, 'Last run' and 'Next run'. A last card 'Last update check' lists 'Tier', 'Panel' and 'OS packages'.
```

Sub-screens (2):

- **Panel release feed result card**

  ```text
  Alternate state: a card 'Panel release feed' subtitled 'Checked just now' inserted after the policy card, listing 'Installed', 'Latest on tier' and 'Update available' as a yes or no pill, or a muted line beginning 'Feed check failed:'.
  ```

- **OS update check job card**

  ```text
  Alternate state: a card 'OS update check (Software)' with a progress bar and a live scrolling monospace log for the queued background check.
  ```

#### Marketplace

`/server-configuration/whm-marketplace` · catalog

```text
Desktop admin panel screen, 1440px. Page header 'Marketplace', breadcrumb Home > Server Configuration > Marketplace, favourite star, description 'Plugins published on the Keel marketplace hub, verified and signed by the vendor, plus the distribution packages that extend the host.' No header action buttons. Body: first a hub catalog card whose toolbar holds a search box 'Search plugins…', a 'All categories' dropdown, a muted line giving the plugin count, the hub host and how many signing keys are pinned, and buttons 'Check for updates' and 'Refresh'; beneath it a grid of plugin cards showing name, version, summary, developer, price and install buttons. Then a card 'Distribution packages', subtitled 'Host software the panel can install through the package manager; not plugins.', with its own toolbar holding 'Search add-ons…', a category dropdown and a count line ending 'package manager: <name>', and a two-column grid of add-on tiles, each with name, vendor, category, an installed or not-installed pill, a description, the package names, and buttons 'Install packages', 'Configure' and 'Docs'. Empty states: 'No plugins match' and 'No add-ons match'.
```

Sub-screens (6):

- **Marketplace hub disabled state**

  ```text
  Alternate state: the hub catalog is replaced by an information banner 'The Keel marketplace hub is not enabled' telling the reader to enable the whm-hub provider in Market Provider Manager and that the license key is entered under Basic Setup → License. Only the distribution-packages catalog is shown below it.
  ```

- **Install plugin modal**

  ```text
  Large modal dialog titled 'Install <plugin name>'. The plugin summary, then key/value rows 'Developer', 'Price', 'Requires host API' and 'Signed by'. A section 'Permissions requested' lists each permission scope with the developer's justification, followed by a trust notice. Footer buttons 'Install v1.2.0' and 'Cancel'.
  ```

- **Plugin detail drawer**

  ```text
  Drawer titled with the plugin name and version, subtitled with its summary, with 'Refresh' and 'Close' in the corner. Key/value rows 'Plugin id', 'Developer', 'Category', 'Price', 'Compatibility', 'Installed', 'Rating' and 'Links'; action buttons 'Install', 'Update', 'Uninstall (keep data)' and red 'Uninstall and purge'; then sections Permissions, Versions table, Changelog, Reviews and a 'Write a review' form.
  ```

- **Uninstall plugin confirmation**

  ```text
  Confirmation dialog titled 'Uninstall <plugin name>?' with the message that it removes the plugin code while its settings, stored data and logs are kept for a later re-install. Buttons 'Uninstall' in red and 'Cancel'.
  ```

- **Uninstall and purge confirmation**

  ```text
  Confirmation dialog titled 'Uninstall and purge <plugin name>?' with the message that it removes the plugin code and deletes its settings, stored data, logs and data directory, and that this cannot be undone. Buttons 'Uninstall and purge' in red and 'Cancel'.
  ```

- **Pending updates banner**

  ```text
  Alternate state: an information banner above the catalog reading '3 marketplace updates available' with a bullet list of plugin ids showing current and latest versions, a red 'security' tag where relevant, and a small 'Update' button on each line.
  ```

### 2. Support

3 screens. Sidebar tile colour for this category is used on its tool cards.

#### Create Support Ticket

`/support/create-support-ticket` · split

```text
Desktop admin panel screen, 1440px. Page header 'Create Support Ticket', breadcrumb Home > Support > Create Support Ticket, favourite star, description 'Open a support request. The ticket is kept on this server and emailed to the configured support address together with a redacted snapshot of the system.'. No header actions. Body: card 'New ticket', subtitle 'Saved on this server and emailed to the support address with a redacted snapshot of the system.', carrying an info banner 'No support email address is configured' and the fields 'Subject', a two-column row of dropdowns 'Severity' and 'Area', a tall 'Description' textarea, 'Reply-to address', and a switch 'Attach a system snapshot', with buttons 'Open ticket' and 'Preview snapshot'. Below, card 'Tickets' with a search box, an 'All statuses' dropdown and a table of 'Reference', 'Subject', 'Severity', 'Area', 'Status', 'Email', 'Opened' plus a 'View' row menu. Pills read open, closed, sent, not sent, low, normal, high, critical. Empty state 'No tickets yet. Tickets opened from this server will be listed here.'
```

Sub-screens (3):

- **System snapshot preview**

  ```text
  Modal dialog 'System snapshot (as attached)', wide, showing a scrolling monospace JSON block of panel and OS versions, load, memory, disks and service states, with footer buttons 'Copy' and 'Close'.
  ```

- **Ticket detail**

  ```text
  Modal dialog titled '<reference> — <subject>', wide. Key/value list of 'Status', 'Severity', 'Area', 'Opened', 'Closed', 'Reply-to', 'Email delivery', 'Delivery detail'; heading 'Description' with wrapped text; collapsible 'System snapshot'. Footer buttons 'Send again', 'Download snapshot', 'Close ticket', 'Delete'.
  ```

- **Delete ticket confirmation**

  ```text
  Confirmation dialog 'Delete ticket', message 'Delete <reference> and its snapshot from this server? Anything already emailed to support is unaffected.', with a red 'Delete' button and 'Cancel'.
  ```

#### Grant Support Access

`/support/grant-cpanel-support-access` · split

```text
Desktop admin panel screen, 1440px. Page header 'Grant Support Access', breadcrumb Home > Support > Grant Support Access, favourite star, description 'Give a support engineer time-boxed access: a fresh SSH key authorized for root and an API token, both removed automatically when the grant expires and recorded in the audit log.'. No header actions. Body: warning banners '<n> grants waiting for cleanup' and '<n> active support grant'. Card 'Grant access' explaining the sshd expiry-time option, with an info banner 'sshd is not installed' carrying an 'Install openssh-server' button, then fields 'Label', 'Duration (hours)', switches 'SSH access as root' and 'API token', a 'Token scope' dropdown and 'Note', with a primary 'Grant access' button. Card 'Grants' with buttons 'Expire overdue now' and refresh, a status dropdown and a searchable table of 'Label', 'Status', 'Grants', 'Expires', 'Granted by', 'Created' with 'Revoke', 'Retry cleanup' and 'Details' row menu items. Pills: active, cleanup pending, expired, revoked. Empty state 'No grants yet. Support access you grant will be listed here.'
```

Sub-screens (3):

- **Access granted secrets**

  ```text
  Modal dialog 'Access granted: <label>', wide, opening with a warning banner 'Shown once.' then a key/value list of 'Expires', 'Granted by', 'Key fingerprint', 'Token prefix', then monospace secret blocks 'SSH private key (give to support)', 'Login command', the authorized_keys line, 'API token (give to support)' and 'Example request', each with copy and download buttons. Footer button 'I have saved these'.
  ```

- **Grant details**

  ```text
  Modal dialog 'Grant: <label>' with a key/value list of 'Status', 'Expires', 'Granted', 'Note', 'SSH key' fingerprint with a copy button, 'API token' prefix linking to the token, 'Ended' and 'Cleanup'. Footer buttons 'Revoke' or 'Retry cleanup', and 'Close'.
  ```

- **Revoke access confirmation**

  ```text
  Confirmation dialog 'Revoke support access', message 'End "<label>" now? The SSH key is removed from root's authorized_keys and the API token stops working immediately.', with a red 'Revoke' button and 'Cancel'.
  ```

#### Support Center

`/support/support-center` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Support Center', breadcrumb Home > Support > Support Center, favourite star, description 'Documentation, vendor and community resources, the in-app API reference, a diagnostics download and the state of open tickets and support access.'. No header actions. Body: a two-column row of three cards. 'Tickets' with a 'New ticket' button, key/value list 'Open', 'Total', 'Email transport', 'Support address' and a bulleted list of open ticket references with severity pills. 'Support access' with a 'Manage' button and key/value list 'Active grants', 'Cleanup pending', 'sshd'. 'Diagnostics' describing the JSON bundle with a 'Download diagnostics' button and a panel version line. Then card '<provider> and community resources' as a grid of external link tiles, card 'In this panel' as a grid of internal link tiles, card 'Documentation shipped with this panel' listing each document title, summary, file path and section chips, and card 'Settings' with fields 'Support email address', 'Provider name', 'Support portal URL', 'Default grant length (hours)', 'Maximum grant length (hours)' and a 'Save' button.
```

Sub-screens (1):

- **Document reader**

  ```text
  Drill-down view replacing the documentation card: card titled with the document name, subtitle 'Section: <title>' or the file path, actions 'Copy', 'Download', 'Whole document', 'All documents', a sticky left table-of-contents of section links and the rendered markdown body beside it.
  ```

### 3. Networking Setup

2 screens. Sidebar tile colour for this category is used on its tool cards.

#### Change Hostname

`/networking-setup/change-hostname` · form

```text
Desktop admin panel screen, 1440px. Page header 'Change Hostname', breadcrumb Home > Networking Setup > Change Hostname, favourite star, description 'Sets the kernel hostname with hostnamectl, maps it in /etc/hosts, updates the panel's hostname setting and can publish the matching A record.' Header actions: none. Body: card 'Current hostname' with a small 'Refresh' button and a key/value list reading 'System hostname', 'Panel setting (basic.hostname)', 'Main IP address', '/etc/hosts entry', 'DNS A record', 'Resolves publicly', 'hostnamectl' and 'Last change', each value a monospace string with a status pill. Card 'New hostname', subtitle 'Must be fully qualified (host.example.com), must not start with www and must not be a domain hosted on this server', with filled inputs 'Hostname' and 'IP address for /etc/hosts' and three switches 'Update /etc/hosts', 'Re-issue self-signed service certificates' and 'Add an A record for the hostname', then buttons 'Change hostname', 'Preview /etc/hosts' and 'Save toggles as defaults'. Below them a two-column 'Before' and 'After' monospace diff of the hosts file. States: pills read 'fully qualified', 'in sync', 'differs', 'missing', 'available'; a red banner warns the name is already a domain of another account.
```

Sub-screens (2):

- **Confirm hostname change**

  ```text
  Confirmation dialog 'Change the hostname to host.example.com?' explaining that hostnamectl sets the kernel hostname immediately, /etc/hosts is rewritten, self-signed service certificates are re-issued and an A record is added. A filled input asks the admin to type the new hostname to confirm. Buttons 'Change hostname' in red and 'Cancel'.
  ```

- **Result card with step list**

  ```text
  Result card titled 'Hostname changed to host.example.com' containing a vertical step list: kernel hostname, /etc/hosts, service certificates, DNS record, panel setting, each row ending in a 'done', 'skipped' or 'failed' pill, followed by a muted note naming the previous hostname and the services to restart.
  ```

#### Resolver Configuration

`/networking-setup/resolver-configuration` · form

```text
Desktop admin panel screen, 1440px. Page header 'Resolver Configuration', breadcrumb Home > Networking Setup > Resolver Configuration, favourite star, description 'The nameservers this server itself uses to resolve names (/etc/resolv.conf or systemd-resolved). Test them live before applying.' Header actions: none. Body: card 'Current configuration', subtitle 'Read from /etc/resolv.conf', with a 'Refresh' button, an information banner explaining that systemd-resolved manages the file, and a key/value list 'Nameservers in use', 'Search domains', 'Options', 'Managed by', 'Panel writes to', 'systemd-resolved', 'Upstream servers (resolvectl)', 'DNS Functions lookups use' and 'Last change', plus a collapsed 'Show /etc/resolv.conf' block of monospace file text. Card 'Resolvers' with a row of preset buttons, four filled inputs 'Primary resolver', 'Secondary resolver', 'Third resolver' and 'Fourth resolver', an input 'Search domains', switches 'Use these resolvers for the panel's DNS checks' and 'Replace /etc/resolv.conf with a static file', and buttons 'Apply resolvers', 'Test these resolvers' and 'Test current'; under them a results table with columns 'Resolver', 'Status', 'Lookups' and 'Avg time'. Card 'Change history', a dense table with columns 'When', 'By', 'Before', 'After' and 'Target'. States: pills read 'healthy', 'partial', 'unreachable', 'running', 'stopped', 'none — resolution is broken'; empty history reads 'Resolver changes applied from this page will appear here'.
```

Sub-screens (2):

- **Confirm apply resolvers**

  ```text
  Confirmation dialog 'Apply resolver configuration?' listing the nameservers and search domains and warning that every program on the server resolves through them from now on and that a wrong address breaks mail, updates and the panel's own lookups. Buttons 'Apply' in red and 'Cancel'.
  ```

- **Applied confirmation banner**

  ```text
  Information banner inside the Resolvers card headed 'Written to /etc/resolv.conf', with lines saying systemd-resolved was restarted, the symlink was removed, the file does not show the new servers yet, and a muted note that DNS Functions now query these resolvers.
  ```

### 4. Security Center

19 screens. Sidebar tile colour for this category is used on its tool cards.

#### Apache mod_userdir Tweak

`/security-center/apache-mod-userdir-tweak` · config

```text
Desktop admin panel screen, 1440px. Page header 'Apache mod_userdir Tweak', breadcrumb Home > Security Center > Apache mod_userdir Tweak, favourite star, description 'mod_userdir serves http://host/~user/ from each account's public_html. Because those URLs share the server's main domain they bypass per-domain bandwidth accounting and SSL, so the panel disables them by default.' No header actions. Body: card 'Status' with key/value rows '~user URLs' carrying a 'Disabled' status pill, 'mod_userdir module loaded', 'Excluded users', and a muted 'Managed file' line with a file path. Card 'Settings', subtitle 'The include is validated with apachectl -t before Apache is reloaded; a rejected configuration is rolled back.', holding a switch 'Enable mod_userdir (~user URLs)' with help 'Users listed below stay disabled even when the feature is on.', a two-column grid of per-account switches under 'Exclude these accounts', and primary button 'Save and reload Apache'. Alternate state: notice 'Apache is not installed on this server, so mod_userdir cannot be configured.' above a greyed-out Settings card.
```

#### SMTP Restrictions

`/security-center/smtp-restrictions` · action

```text
Desktop admin panel screen, 1440px. Page header 'SMTP Restrictions', breadcrumb Home > Security Center > SMTP Restrictions, favourite star, description 'Block outgoing SMTP from non-mail users.' No header actions. Body: card 'Current state' with a key/value list of 'Status' carrying an 'Enabled' or 'Disabled' pill and 'Effect' reading 'Restricted (nftables)' or 'Not restricted', then buttons 'Enable SMTP restrictions' or 'Disable SMTP restrictions' plus 'Refresh'. Card 'How the restriction works' with a row of pills 'IPv4: restricted' and 'IPv6: no tooling', a warning banner about port 25 still being reachable over IPv6, a second warning banner about rules switched on in the panel but not active, and muted paragraphs listing the allowed groups and the firewall backend. Alternate state: notice 'No supported firewall (iptables or nftables) is installed, so outbound SMTP cannot be restricted.'
```

Sub-screens (1):

- **Enable SMTP restrictions confirmation**

  ```text
  Confirmation dialog 'Enable SMTP restrictions?' with the message 'Outbound connections to port 25 will be rejected unless they come from root or the mail server groups. Scripts that talk to remote SMTP servers directly (instead of through the local mail server) will stop working.' Buttons 'Enable SMTP restrictions' and 'Cancel'.
  ```

#### Compiler Access

`/security-center/compiler-access` · action

```text
Desktop admin panel screen, 1440px. Page header 'Compiler Access', breadcrumb Home > Security Center > Compiler Access, favourite star, description 'Allow or deny compilers to unprivileged users.' No header actions. Body: card 'Current state' with a key/value list of 'Status' carrying an 'Enabled' or 'Disabled' pill and 'Effect' reading 'Compilers available to all users' or 'Compilers restricted to privileged users', followed by buttons 'Allow compilers' or 'Deny compilers' plus 'Refresh'. Card 'Affected binaries', subtitle 'Denying access sets the compiler binaries to mode 0750 (owner and group only); allowing restores 0755. Exploit kits uploaded to compromised accounts often depend on a working compiler.', holding a table with columns 'Binary', 'Also reached via', 'Mode' and 'Everyone may run' showing yes or no pills. Empty state inside the first card: 'No compilers are installed' with 'gcc, cc, g++ and clang were not found in /usr/bin, so there is nothing to restrict.'
```

Sub-screens (1):

- **Deny compilers confirmation**

  ```text
  Confirmation dialog 'Deny compilers?' with the message 'Unprivileged users (hosting accounts) will no longer be able to run gcc, cc, g++ or clang. Root and group members keep access. Deny access unless accounts need to build software.' Buttons 'Deny compilers' and 'Cancel'.
  ```

#### Configure Security Policies

`/security-center/configure-security-policies` · config

```text
Desktop admin panel screen, 1440px. Page header 'Configure Security Policies', breadcrumb Home > Security Center > Configure Security Policies, favourite star, description 'Policies that govern how users log in to the panel.' No header actions. Body: three settings cards stacked. Card 'Two-factor authentication' with four switches, each with helper text: 'Require two-factor authentication for root', 'Require two-factor authentication for resellers', 'Require two-factor authentication for account users' and 'Only users with 2FA may create API tokens'. Card 'Sessions' with a switch 'Limit logins to verified IP addresses', a number field 'Idle session timeout (minutes)' helped by '0 uses the server default (WHM_SESSION_TTL).', and a switch 'One active session per user'. Card 'Passwords' with number fields 'Maximum password age (days)' and 'Minimum password strength (0-100)'. A sticky action bar at the bottom holds a primary 'Save' button and a 'Reset' button, both disabled until something changes.
```

#### cPHulk Brute Force Protection

`/security-center/cphulk-brute-force-protection` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'cPHulk Brute Force Protection', breadcrumb Home > Security Center > cPHulk Brute Force Protection, favourite star, description 'Block repeated failed logins.' Header actions: a 'Refresh' button. Body: a segmented control with four tabs, 'Status and settings', 'Current blocks' with a count badge, 'Login history' and 'Allow and deny lists'. The first tab is shown: a row of four stat tiles labelled 'Protection' (showing an enabled pill), 'Active blocks', 'Failed logins (24h)' and 'Login attempts (24h)'. Card 'Settings' with a switch 'Enable cPHulk brute force protection', number fields 'Failures per IP before blocking', 'Block duration (minutes)' and 'Keep login history (days)', switches 'Also drop blocked addresses in the firewall' and 'Denylist entries create permanent blocks', and a primary 'Save' button. Card 'Top offending addresses (24h)' with a table of 'Address', 'Failures' and 'Last seen'.
```

Sub-screens (5):

- **Current blocks tab**

  ```text
  Drill-down view of the 'Current blocks' tab. Card 'Block an address' with fields 'IP address or CIDR', 'Duration (minutes)' and 'Reason', a switch 'Permanent (one-day blocks and longer belong on the denylist)' and a primary 'Block' button. Card 'Currently blocked' with a 'Remove all' button and a table of 'Address', 'Reason', 'Blocked' and 'Expires', each row offering 'Unblock'.
  ```

- **Login history tab**

  ```text
  Drill-down view of the 'Login history' tab: a single card holding a searchable, sortable table with the placeholder 'Search address or user...', a 'Failures only' switch in the toolbar, columns 'When', 'Address', 'User' and 'Result' showing success or failed pills, and pagination. Empty text 'Login attempts appear here as soon as someone signs in.'
  ```

- **Allow and deny lists tab**

  ```text
  Drill-down view of the 'Allow and deny lists' tab. Card 'Add to a list' with a dropdown 'List' offering Allowlist and Denylist, a required 'IP address or CIDR' field, a 'Comment' field and an 'Add' button. Then cards 'Allowlist' and 'Denylist', each a table of 'Address / network', 'Comment' and 'Added' with a 'Remove' row action.
  ```

- **Remove every block confirmation**

  ```text
  Confirmation dialog 'Remove every block?' with the message 'All currently blocked addresses will be able to log in again.' Buttons 'Remove all' and 'Cancel'.
  ```

- **Remove list entry confirmation**

  ```text
  Confirmation dialog titled 'Remove 192.0.2.0/24 from the allow list?' with no body text, and buttons 'Remove' and 'Cancel'.
  ```

#### Host Access Control

`/security-center/host-access-control` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Host Access Control', breadcrumb Home > Security Center > Host Access Control, favourite star, description 'TCP wrappers rules (hosts.allow) for daemons compiled with libwrap such as sshd, vsftpd and dovecot. Rules are matched top to bottom; the first match wins, and a connection that matches nothing is allowed.' No header actions. Body: an information banner about libwrap not being detected and a warning banner '/etc/hosts.deny contains rules the panel did not write.' Card 'Rules' with an 'Add rule' button and an editable table whose columns are 'Daemon', 'Access list (host, IP, network/mask, ALL, LOCAL)', 'Action' (a dropdown of Allow and Deny), 'Comment' and per-row move up, move down and delete icon buttons. Below it buttons 'Save and write /etc/hosts.allow' and 'Reset', plus two muted tips about locking SSH down and IPv6 bracket notation. Card 'Current files' showing two side-by-side log panes for /etc/hosts.allow and /etc/hosts.deny. Empty table row: 'No rules yet, so every connection is allowed. Rules you add appear here in matching order.'
```

#### Manage External Authentications

`/security-center/manage-external-authentications` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage External Authentications', breadcrumb Home > Security Center > Manage External Authentications, favourite star, description 'OpenID Connect providers (Okta, Azure AD, Keycloak, Google Workspace and others) that panel users may link to their account and sign in with.' Header actions: a primary 'Add provider' button with a plus icon. Body: card 'Policy' with two switches, 'Allow external authentication on the login page' and 'Automatically link identities whose verified email matches a panel user' with helper text 'Otherwise users must link a provider while signed in.' Card 'Providers' holding a table with columns 'Provider' (display name over a monospaced identifier), 'Issuer' as a link, 'Client ID', 'Discovery' showing a 'fetched' or 'not run' pill, 'Linked users' right-aligned and 'Status' as an enabled or disabled pill. Each row has a menu with 'Discover', 'Edit', 'Disable' and 'Delete'. Empty state: 'Identity providers you add appear here.'
```

Sub-screens (4):

- **Add an identity provider modal**

  ```text
  Modal dialog 'Add an identity provider', large. Two-column form with fields 'Identifier' (required, help 'Lowercase; used in URLs'), 'Display name' (required), 'Issuer URL' (required), 'Client ID' (required), 'Client secret' (masked, help 'Stored encrypted with the panel master key') and 'Scopes'. Below, a switch 'Enabled'. Buttons 'Add provider' and 'Cancel'.
  ```

- **Edit provider modal**

  ```text
  Modal dialog titled 'Edit Company SSO', large. Same form without the 'Identifier' field: 'Display name', 'Issuer URL', 'Client ID', 'Client secret' with help 'Leave empty to keep the stored secret', 'Scopes' and an 'Enabled' switch. Buttons 'Save' and 'Cancel'.
  ```

- **Foreign endpoints confirmation**

  ```text
  Confirmation dialog 'Endpoints on other hosts' warning that the discovered endpoints live on different hosts and that 'The client secret is sent to the token endpoint, so only allow this when the provider documents those hosts.' Destructive styling. Buttons 'Allow and discover' and 'Cancel'.
  ```

- **Delete provider confirmation**

  ```text
  Confirmation dialog titled 'Delete provider "Company SSO"?' with the message '3 linked users will lose the ability to sign in through it.' Destructive styling. Buttons 'Delete' and 'Cancel'.
  ```

#### Manage root's SSH Keys

`/security-center/manage-roots-ssh-keys` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage root's SSH Keys', breadcrumb Home > Security Center > Manage root's SSH Keys, favourite star, description 'Generate, import and authorise root SSH keys.' No header actions. Body: card 'Key pairs in /root/.ssh' with a dense table of 'Name', 'Type', 'Fingerprint', 'Comment', 'Authorized' (yes or no pill) and 'Created'; each row has a menu with 'De-authorize' or 'Authorize', 'View private key', 'Copy public key' and 'Delete key pair'. Card 'Authorized keys', subtitle 'Every key that may log in as root, including keys imported from elsewhere.', with a table of 'Type', 'Fingerprint', 'Comment' and 'Options' and a 'De-authorize' row action. Below, two side-by-side cards: 'Generate a new key' with fields 'Name', 'Type', 'Bits', 'Comment', 'Passphrase', a switch 'Authorize immediately' and a 'Generate key' button; and 'Import a public key' with a monospaced 'Public key' textarea and an 'Authorize key' button.
```

Sub-screens (4):

- **De-authorize key confirmation**

  ```text
  Confirmation dialog 'Remove this key from authorized_keys?' with the message 'ed25519 SHA256:abc... (root@server) will no longer be able to log in as root.' Destructive styling. Buttons 'De-authorize' and 'Cancel'.
  ```

- **Delete key pair confirmation**

  ```text
  Confirmation dialog titled 'Delete key pair "id_ed25519"?' with the message 'The private and public key files are removed from /root/.ssh and the key is de-authorized. This cannot be undone.' Includes a text field where the key name must be typed to confirm. Buttons 'Delete' and 'Cancel'.
  ```

- **Show private key confirmation**

  ```text
  Confirmation dialog 'Show the private key?' with the message 'Anyone who sees this key can log in as root. The export is recorded in the audit log.' Buttons 'Show key' and 'Cancel'.
  ```

- **Private key modal**

  ```text
  Modal dialog titled 'Private key: id_ed25519', large, showing a scrollable monospaced log pane with the private key text and a muted line beneath reading 'Public key:' followed by the key. Footer buttons 'Copy' and 'Close'.
  ```

#### Manage Wheel Group Users

`/security-center/manage-wheel-group-users` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Wheel Group Users', breadcrumb Home > Security Center > Manage Wheel Group Users, favourite star, description 'Members of the wheel (or sudo) group may become root with su. Keep this list as short as possible.' No header actions. Body: card titled 'Add a user to wheel' holding a single dropdown labelled 'User' with the placeholder 'Choose a user...' and a primary button 'Add to wheel' that stays disabled until a user is picked. Card titled 'Current members of wheel' holding a dense table with one column, 'User', showing monospaced usernames, and a 'Remove' action on each row. Empty state inside that table: 'Nobody may su to root yet.' Alternate state when no such group exists: a single card with the empty state 'No wheel or sudo group exists' and the line 'Create one with groupadd wheel and configure pam_wheel before managing members here.'
```

Sub-screens (1):

- **Remove member confirmation**

  ```text
  Confirmation dialog titled 'Remove alice from wheel?' with the message 'The user will no longer be able to su to root.' Destructive styling. Buttons 'Remove' and 'Cancel'.
  ```

#### ModSecurity Configuration

`/security-center/modsecurity-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'ModSecurity Configuration', breadcrumb Home > Security Center > ModSecurity Configuration, favourite star, description 'Web application firewall settings.' No header actions. Body: card 'Status' with key/value rows 'Rule engine' carrying an On, DetectionOnly or Off pill, 'Module loaded in Apache', 'Distribution config' as a file path, 'Rules disabled from Tools' as a count and 'Vendor rule sets', plus a muted 'Managed file' path line. Card 'Engine directives', subtitle 'Values here override the distribution file. Empty = keep the distribution value. Validated with apachectl -t and rolled back on error.', holding a two-column grid of fields: 'Rule engine', 'Audit engine', 'Audit relevant status (regex)', 'Audit log parts', 'Inspect request bodies', 'Inspect response bodies', 'Request body limit (bytes)', 'Request body limit without files (bytes)', 'When the body limit is exceeded', 'PCRE match limit', 'PCRE recursion limit' and 'Connection engine', then buttons 'Save and reload Apache' and 'Reset'. Alternate state: notice that ModSecurity is not installed above a greyed directives card.
```

#### ModSecurity Tools

`/security-center/modsecurity-tools` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'ModSecurity Tools', breadcrumb Home > Security Center > ModSecurity Tools, favourite star, description 'Review hits and manage rules.' No header actions. Body: a segmented control with two tabs, 'Hits list' and 'Rules list' carrying a badge such as '4 disabled'. The hits tab is shown: card 'Recent hits', subtitle 'Parsed from /var/log/apache2/error.log', with a 'Refresh' button and a dense table whose columns are 'Time', 'Client', 'Host', 'URI', 'Rule', 'Message', 'Severity' as a coloured pill and 'Action'; each row offers 'Disable rule'. Empty state: 'Blocked and logged requests appear here as ModSecurity records them in the error log.' Alternate state: a capability notice reading 'ModSecurity is not installed on this server.'
```

Sub-screens (3):

- **Rules list tab**

  ```text
  Drill-down view of the 'Rules list' tab: card 'Rules' subtitled '12480 rules across 37 files', a search box 'Search id, message, tag or file', a 'Disabled only' switch in the toolbar, and a dense paginated table with columns 'Rule ID', 'Message', 'Severity', 'Phase', 'Source' (vendor over filename) and 'Enabled' as a per-row switch.
  ```

- **Disable rule from hits confirmation**

  ```text
  Confirmation dialog titled 'Disable rule 942100?' with the message 'The rule will be removed with SecRuleRemoveById for the whole server and Apache reloaded.' Destructive styling. Buttons 'Disable' and 'Cancel'.
  ```

- **Disable rule from rules list confirmation**

  ```text
  Confirmation dialog titled 'Disable rule 942100?' with the message 'SQL Injection Attack Detected will no longer be evaluated. Prefer disabling a single rule over turning the engine off.' Destructive styling. Buttons 'Disable' and 'Cancel'.
  ```

#### ModSecurity Vendors

`/security-center/modsecurity-vendors` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'ModSecurity Vendors', breadcrumb Home > Security Center > ModSecurity Vendors, favourite star, description 'Install and update rule vendors.' No header actions. Body: card 'Installed vendors' with a table of 'Vendor', 'Source' as a link, 'Installed / updated' and 'Enabled' as a per-row switch, each row offering 'Update' and 'Remove'; empty text 'Installed vendor rule sets appear here. Add the OWASP Core Rule Set below to start.' A card 'Installation progress' with a streaming log appears while a job runs. Card 'Add a vendor', subtitle about accepting a .tar.gz, .tar.bz2, .tar.xz, .tar or .zip archive over https, holding a warning banner that the distribution's OWASP Core Rule Set is already loaded, two preset buttons 'OWASP Core Rule Set 4.x' and 'Comodo WAF (requires your account URL)', fields 'Name' and 'Archive URL (https)', an 'Install' button and a muted 'Engine status' pill.
```

Sub-screens (1):

- **Remove vendor confirmation**

  ```text
  Confirmation dialog titled 'Remove vendor "owasp-crs"?' with the message 'Its rule files are deleted and Apache is reloaded without them.' Destructive styling. Buttons 'Remove' and 'Cancel'.
  ```

#### Password Strength Configuration

`/security-center/password-strength-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Password Strength Configuration', breadcrumb Home > Security Center > Password Strength Configuration, favourite star, description 'Minimum strength (0-100) a password must reach before it is accepted. Leave a context empty to use the default.' No header actions. Body: card 'Default' with one number field 'Default minimum strength' helped by '65 rejects dictionary words and short passwords; 80 requires mixed case, digits and symbols.' Card 'Per-context overrides', subtitle 'Empty = use the default.', with a two-column grid of number fields placeholdered 'default': 'Hosting account passwords', 'Panel logins', 'Email accounts', 'FTP accounts', 'Database users' and 'SSH / shell users'. Card 'Test a password', subtitle 'Scores with the same algorithm the server applies when passwords are set.', with a masked 'Password' field, a 'Context' dropdown, a 'Check' button and a strength meter reading 'Score 72 / minimum 65 for account: accepted'. A sticky bar holds 'Save' and 'Reset'.
```

#### Security Advisor

`/security-center/security-advisor` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Security Advisor', breadcrumb Home > Security Center > Security Advisor, favourite star, description 'Read-only probes of SSH, firewall, cPHulk, ModSecurity, file permissions, package updates, PHP advisories and panel settings, graded with links to the page that fixes each finding. A scheduled scan runs nightly.' Header actions: a primary button 'Scan again'. Body: a row of four stat tiles 'Critical', 'Warnings', 'Informational' and 'Passed checks', then a muted line 'Last scan ... (nightly).' Below, one card per grade titled 'Critical', 'Warnings', 'Informational' and 'Passed checks', each a borderless table whose rows carry a grade pill, the finding title with smaller detail text and version pills, and right-aligned action buttons plus an 'Advisory' link and a fix link to the page that solves it. A 'Update progress' card streams a job log. Last card: 'PHP advisory list' with a monospaced JSON textarea, a collapsible 'Format' note and a 'Save list' button. Empty state: 'No scan has run yet' with 'Graded findings appear here after the first scan. Scans only read; they never change anything.'
```

Sub-screens (1):

- **Run finding action confirmation**

  ```text
  Confirmation dialog titled after the finding's action button, for example 'Update PHP?', with the message 'Runs update php as a background job (PHP 8.1 is affected by CVE-2024-xxxx). The advisor scans again when it finishes.' Buttons carrying the action label and 'Cancel'.
  ```

#### Security Questions

`/security-center/security-questions` · config

```text
Desktop admin panel screen, 1440px. Page header 'Security Questions', breadcrumb Home > Security Center > Security Questions, favourite star, description 'Recovery questions for account users. Not enforced yet: the settings are stored for the authentication layer, which does not prompt for questions on login or password reset today; the Security Advisor flags the policy while it is switched on but inactive.' No header actions. Body: card 'Policy' with a switch 'Require security questions' helped by 'Intended behaviour: account users set up their questions on their next login. Stored only; not enforced yet.', number fields 'Questions each user must answer' and 'Minimum answer length', and a switch 'Allow users to write their own questions'. Card 'Question pool', subtitle 'One question per entry; users will pick from this list once enforcement lands.', with a multi-line 'Questions' box helped by 'One per line. Keep answers hard to look up on social media.' A sticky bar holds 'Save' and 'Reset'.
```

#### Shell Fork Bomb Protection

`/security-center/shell-fork-bomb-protection` · config

```text
Desktop admin panel screen, 1440px. Page header 'Shell Fork Bomb Protection', breadcrumb Home > Security Center > Shell Fork Bomb Protection, favourite star, description 'Per-user process and memory limits.' No header actions. Body: card 'Status' with key/value rows 'Protection' carrying an enabled or disabled pill, 'Mechanism' reading 'pam_limits (/etc/security/limits.d)', 'Supported' carrying a 'Yes' or 'No limits.d on this host' pill, and 'Managed file' showing a path. Card 'Limits for shell users', subtitle 'Hard limits applied to every PAM login session except root and the exempt groups.', holding a warning banner 'Cannot be enabled here' with 'This host has no /etc/security/limits.d, so PAM limits cannot be applied.', then a two-column grid of fields 'Maximum processes (nproc)' helped by 'The classic default is 35.', 'Maximum open files (nofile)', 'Maximum virtual memory (MB)' and 'Exempt groups' helped by 'Comma-separated. Members keep unlimited resources (e.g. wheel, sudo).' Buttons 'Save limits' or 'Enable protection', and a destructive 'Disable'.
```

Sub-screens (1):

- **Disable protection confirmation**

  ```text
  Confirmation dialog 'Disable fork bomb protection?' with the message 'Users with shell access will again be able to spawn unlimited processes.' Destructive styling. Buttons 'Disable' and 'Cancel'.
  ```

#### SSH Password Authorization Tweak

`/security-center/ssh-password-authorization-tweak` · config

```text
Desktop admin panel screen, 1440px. Page header 'SSH Password Authorization Tweak', breadcrumb Home > Security Center > SSH Password Authorization Tweak, favourite star, description 'Toggle SSH password authentication.' No header actions. Body: card 'Effective configuration', subtitle 'Read from /etc/ssh/sshd_config', with key/value rows 'Password authentication' and 'Root login' as pills, 'Authorized root keys' as a link reading '2 keys', and 'Drop-in include active'; beneath, a muted managed-file path, a note about the older drop-in, and a warning banner 'Some panel settings are not in effect.' listing each shadowed directive. Card 'Settings', subtitle 'Written to the panel's drop-in, validated with sshd -t and rolled back if sshd rejects them.', with a two-column grid of 'Password authentication', 'Permit root login', 'Public key authentication', 'Permit empty passwords', 'Max authentication tries' and 'Port', then a primary button 'Save and reload sshd'.
```

Sub-screens (1):

- **Lockout confirmation**

  ```text
  Confirmation dialog 'No root SSH keys are authorized' with the message 'Disabling password authentication without an authorized key will lock root out of SSH. Continue anyway?' Destructive styling, with a text field in which the word LOCKOUT must be typed to confirm. Buttons 'Disable passwords' and 'Cancel'.
  ```

#### Traceroute Enable/Disable

`/security-center/traceroute-enable-disable` · action

```text
Desktop admin panel screen, 1440px. Page header 'Traceroute Enable/Disable', breadcrumb Home > Security Center > Traceroute Enable/Disable, favourite star, description 'Control traceroute availability.' No header actions. Body: card 'Current state' with a key/value list of 'Status' carrying an 'Enabled' or 'Disabled' pill and 'Effect' reading 'Traceroute available to all users' or 'Traceroute restricted to privileged users', followed by buttons 'Enable traceroute' or 'Disable traceroute' plus 'Refresh'. Card 'Affected binaries', subtitle 'Disabling sets the binaries to mode 0750 so unprivileged users cannot probe your network topology; enabling restores 0755.', holding a table with columns 'Binary', 'Also reached via', 'Mode' and 'Everyone may run' showing yes or no pills. Empty state inside the first card: 'No traceroute tools are installed' with 'traceroute, tracepath and mtr were not found on this server.'
```

Sub-screens (1):

- **Disable traceroute confirmation**

  ```text
  Confirmation dialog 'Disable traceroute?' with the message 'Hosting accounts will no longer be able to run traceroute, tracepath or mtr. Root keeps access.' Destructive styling. Buttons 'Disable traceroute' and 'Cancel'.
  ```

#### Two-Factor Authentication

`/security-center/two-factor-authentication` · form

```text
Desktop admin panel screen, 1440px. Page header 'Two-Factor Authentication', breadcrumb Home > Security Center > Two-Factor Authentication, favourite star, description 'Time-based one-time passwords for panel logins.' No header actions. Body: a warning banner 'Two-factor authentication is required for your role.' with 'The server security policy requires it before you can use the rest of the panel. Set it up below to continue.' Card 'Your account', subtitle 'Signed in as root', with a key/value row 'Status' carrying an 'Enabled' or 'Not enabled' pill, and either a primary button 'Set up two-factor authentication' or a destructive 'Disable'. Card 'Server policy' with switches 'Require two-factor authentication for the root user' and 'Require two-factor authentication for account users', each with helper text.
```

Sub-screens (3):

- **Enrolment form state**

  ```text
  Drill-down view inside the 'Your account' card after 'Set up two-factor authentication' is pressed: instructions to scan with an authenticator app, a centred QR code, a key/value list of 'Secret key' and 'Account', a muted otpauth URI line, a required 'Verification code' field limited to six digits, and buttons 'Enable' and 'Cancel'.
  ```

- **Disable two-factor confirmation**

  ```text
  Confirmation dialog 'Disable two-factor authentication?' with the message 'Your account will be protected by password only.' Destructive styling. Buttons 'Continue' and 'Cancel'.
  ```

- **Confirm it is you modal**

  ```text
  Small modal dialog 'Confirm it is you' with the muted line 'Turning the second factor off needs your current password or a code from your authenticator app.', a masked field 'Current password' and a field 'Or a 6-digit code'. Footer buttons 'Cancel' and a destructive 'Disable'.
  ```

### 5. Server Contacts

2 screens. Sidebar tile colour for this category is used on its tool cards.

#### Contact Manager

`/server-contacts/contact-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Contact Manager', breadcrumb Home > Server Contacts > Contact Manager, favourite star, description 'Who the server tells when something happens: email, SMS gateway, Slack, Pushover and webhook contacts, the events each one receives, the outgoing mail transport and the scheduled service/disk/certificate checks.' Header actions: none. Body: card 'Contacts' with an 'Add contact' button and a dense table with columns 'Name', 'Channel', 'Address', 'Events', 'Min. severity' and 'Last sent', each row carrying a '...' menu of 'Test', 'Edit', 'Disable' and 'Remove'. Card 'Delivery' with a switch 'Send notifications', inputs 'From address' and 'Keep the delivery log for (days)' and an inline email box with a 'Send test' button. Card 'SMTP relay' with 'Host', 'Port', 'Security', 'Username' and 'Password' and switches for self-signed certificates, plaintext authentication and preferring the relay. Card 'Webhooks' with one switch. Card 'Monitoring checks' with 'Last run', 'Last result', 'Next scheduled run' and 'Open alerts', numeric inputs for disk threshold, repeat interval and certificate warning days, and buttons 'Save' and 'Run checks now'. Cards 'Event catalog' and 'Delivery log' with filter dropdowns and a search box. States: severity and result pills, empty text 'No contacts yet.'
```

Sub-screens (4):

- **Add a contact**

  ```text
  Modal dialog 'Add a contact' with inputs 'Name' and a 'Channel' dropdown, the channel's address field, 'Minimum severity' dropdown, switches 'Enabled' and 'Receive every event', and, when that is off, a grid of grouped event checkboxes. Buttons 'Add contact' and 'Cancel'.
  ```

- **Edit contact**

  ```text
  Modal dialog 'Edit On-call pager' with the same contact fields pre-filled, plus channel-specific inputs 'Application token', 'Signing secret' with a 'Remove the stored secret' switch, or 'Channel override', each noting a stored secret is masked. Buttons 'Save changes' and 'Cancel'.
  ```

- **Confirm remove contact**

  ```text
  Confirmation dialog 'Remove On-call pager?' saying the email contact ops@example.com stops receiving notifications and that its delivery history is kept. Buttons 'Remove' in red and 'Cancel'.
  ```

- **Monitoring check run log**

  ```text
  Progress log panel inside the 'Monitoring checks' card streaming the running check, followed by an information banner headed 'Checked 12 service(s) and 3 filesystem(s)' listing services that are down, filesystems low on disk and expiring certificates.
  ```

#### Edit System Mail Preferences

`/server-contacts/edit-system-mail-preferences` · config

```text
Desktop admin panel screen, 1440px. Page header 'Edit System Mail Preferences', breadcrumb Home > Server Contacts > Edit System Mail Preferences, favourite star, description 'Where mail addressed to root ends up (the root entry in /etc/aliases) and which panel events are mailed to root in addition to the contacts in Contact Manager.' Header actions: none. Body: two side-by-side cards. Left, 'Where root's mail goes' with a key/value list 'Alias file', 'Rebuild after saving' and 'Mail transport', then two editable address lists, 'Forward root's mail to' and 'Forward mail for nobody to', each showing the current targets as removable monospace chips above an input and an 'Add' button, and a button 'Send a test message to root'. Right, 'Events that also mail root' with grouped checkboxes of event names, each labelled with its severity, and buttons 'Select all' and 'Select none'. Below, card 'Other aliases on this server', a dense table with columns 'Alias' and 'Delivers to'. A sticky bottom bar holds 'Save' and 'Reset'. States: a warning banner 'No mail transport'; an information banner 'Root mail goes through the SMTP relay'; empty list text 'Not forwarded (local mailbox)'.
```

### 6. Resellers

10 screens. Sidebar tile colour for this category is used on its tool cards.

#### Change Ownership of an Account

`/resellers/change-ownership-of-an-account` · form

```text
Desktop admin panel screen, 1440px. Page header 'Change Ownership of an Account', breadcrumb Home > Resellers > Change Ownership of an Account, favourite star, description 'Moves one hosting account to root or to another reseller. The new owner's limits are reported, not enforced, so an over-limit reseller is flagged after the move.' No header action buttons. Body: card 'Account' holding a 'Filter' text input placeholder 'Type to filter by user, domain or owner' and an 'Account' dropdown with helper text '12 accounts'; a card titled with the chosen domain and username showing a key and value list 'Current owner', 'Package', 'IP', 'Status' with an Active or Suspended pill, then a required 'New owner' dropdown with helper 'Root or a reseller' and a primary button 'Change ownership'; card 'Last change' listing 'Account', 'From', 'To' and 'Warnings'.
```

Sub-screens (1):

- **Confirm ownership change**

  ```text
  Confirmation dialog titled 'Move acme to reseller1?' with body text saying the new owner gains full control of the domain while the current owner loses it, and that packages, IPs and DNS are unchanged. Buttons 'Cancel' and a primary 'Change owner'.
  ```

#### Change Ownership of Multiple Accounts

`/resellers/change-ownership-of-multiple-accounts` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Change Ownership of Multiple Accounts', breadcrumb Home > Resellers > Change Ownership of Multiple Accounts, favourite star, description 'Select accounts and reassign them to root or a reseller in one go. Filter by current owner to move a whole reseller's portfolio.' No header action buttons. Body: three stat tiles 'Accounts', 'Shown', 'Selected'; a card with a selectable table, a search box 'Filter by user, domain or owner', a toolbar holding an 'Any current owner' dropdown, a 'New owner' dropdown and a primary button reading 'Move 4 to reseller1', columns 'User', 'Domain', 'Current owner', 'Package' and 'Status' with Active and Suspended pills, empty state 'Hosting accounts matching the filter will be listed here.'; a card 'Last run: 4 moved to reseller1' with a dense table 'Account', 'Result' and 'Warnings'.
```

Sub-screens (1):

- **Confirm bulk ownership change**

  ```text
  Confirmation dialog titled 'Move 4 account(s) to reseller1?' with body text explaining each account is reassigned individually and accounts already owned by the target are reported as unchanged. Buttons 'Cancel' and a primary 'Change ownership'.
  ```

#### Edit Reseller Nameservers and Privileges

`/resellers/edit-reseller-nameservers-and-privileges` · form

```text
Desktop admin panel screen, 1440px. Page header 'Edit Reseller Nameservers and Privileges', breadcrumb Home > Resellers > Edit Reseller Nameservers and Privileges, favourite star, description 'Choose which privileges a reseller has, grouped by area, and the nameservers recorded for its accounts. An empty selection denies everything.' Body: card 'Choose a reseller' with a 'Reseller' dropdown; a card named after the reseller, subtitle 'Hosting account example.com', listing 'Status' pill, 'Accounts', 'Current privileges', 'Current nameservers'; card 'Nameservers' subtitle 'Blank entries fall back to the server's nameservers from Basic Setup' with 'Nameserver 1' to 'Nameserver 4' inputs and a switch 'Reseller operates these nameservers'; card 'Privileges' with a 'Load an ACL list' dropdown plus 'Apply' and 'Delete', a 'Save the selection as a list' input plus 'Save', a '14 privilege(s) selected' line, grouped checkbox sections each with 'Select all' and 'Clear', and a primary button 'Save privileges and nameservers'.
```

Sub-screens (2):

- **Confirm All Features grant**

  ```text
  Confirmation dialog titled 'Grant root-level access?' with body text saying 'All Features' gives this reseller every privilege on the server, including ones outside the list. Buttons 'Cancel' and a destructive 'Grant'.
  ```

- **Confirm ACL list deletion**

  ```text
  Confirmation dialog titled 'Delete ACL list "support-tier-2"?' with body text 'Resellers keep the privileges they already have.' Buttons 'Cancel' and a destructive 'Delete'.
  ```

#### Email All Resellers

`/resellers/email-all-resellers` · form

```text
Desktop admin panel screen, 1440px. Page header 'Email All Resellers', breadcrumb Home > Resellers > Email All Resellers, favourite star, description 'Sends a plain-text message to every reseller's email address. {{username}}, {{accounts}} and {{hostname}} are replaced per recipient. Delivery goes through this server's mail server.' Body: card 'Recipients' subtitle '6 reseller(s) with an email address; 2 without one are skipped' with a dense table 'Reseller', 'Email', 'Accounts'; card 'Message' with a 'From address' input, a required 'Subject' input placeholder 'Scheduled maintenance on {{hostname}}', a required twelve-row 'Body' text area, and a primary button 'Send to 6 reseller(s)'; card 'Recent broadcasts' subtitle 'Messages and addresses are kept here, visible to root only' with a dense table 'Sent', 'Subject', 'From', 'By', 'Status' pill, 'Delivered', 'Failed', empty state 'Messages sent from this page will be listed here.'
```

Sub-screens (2):

- **Confirm broadcast send**

  ```text
  Confirmation dialog titled 'Email 6 reseller(s)?' with body text saying the subject line is handed to the mail server for every reseller with an email address. Buttons 'Cancel' and a primary 'Send'.
  ```

- **Delivery progress state**

  ```text
  Alternate state of the page showing an extra card 'Delivery' between the message form and the history, containing a scrolling job log with a progress bar, then a key and value list 'Sent', 'Failed' and 'Failures'.
  ```

#### Manage Reseller's IP Delegation

`/resellers/manage-resellers-ip-delegation` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Reseller's IP Delegation', breadcrumb Home > Resellers > Manage Reseller's IP Delegation, favourite star, description 'Delegated addresses are the only ones a reseller may assign when creating accounts, besides its shared IP. An address can be delegated to one reseller at a time; the main, reserved and dedicated addresses are never delegated.' Body: card 'Reseller' with a 'Reseller' dropdown; card 'Addresses available to reseller1' subtitle 'Reseller shared IP: server default' with a small header button 'Change shared IP' and a selectable table of 'Address', 'Family', 'Interface', 'Role' and 'Delegated', role pills reading 'main IP', 'reserved', 'dedicated: acme', 'dynamic', 'server shared IP' or plain 'free', Yes and No delegated pills, then buttons 'Save delegation (3 address(es))' and 'Reset', empty state about adding addresses under IP Functions; card 'Not delegatable' subtitle 'Main, reserved, dedicated, dynamic or delegated to another reseller' with a dense 'Address' and 'Why' table.
```

#### Manage Reseller's Shared IP

`/resellers/manage-resellers-shared-ip` · form

```text
Desktop admin panel screen, 1440px. Page header 'Manage Reseller's Shared IP', breadcrumb Home > Resellers > Manage Reseller's Shared IP, favourite star, description 'The shared IP is the address a reseller's new accounts receive when no dedicated address is chosen. Existing accounts are not moved; use Change Site's IP Address for those.' No header action buttons. Body: card 'Reseller' with a 'Reseller' dropdown; card 'Shared IP for reseller1' with a small header button 'Delegate addresses', a key and value list 'Current', 'Server shared IP', 'Delegated addresses', then a field 'Use' with helper 'Delegated or free addresses can be chosen; reserved and dedicated ones cannot' holding a vertical radio list whose first option is 'Server shared IP' described as 'Accounts the reseller creates use the server-wide shared address' and whose remaining options are addresses described as 'Main IP', 'Delegated to this reseller' or 'Free address (not delegated)', and a primary button 'Save shared IP'.
```

#### Reseller Center

`/resellers/reseller-center` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Reseller Center', breadcrumb Home > Resellers > Reseller Center, favourite star, description 'Resellers are panel logins that own hosting accounts. Give an existing account reseller status or add a standalone login, then set its limits, privileges, packages, nameservers and shared IP.' Header action: primary button 'Add reseller' with a plus icon. Body: four stat tiles 'Resellers', 'Suspended', 'Accounts owned', 'Over limits'; a card with a paged, sortable table, search box 'Search reseller or email…', columns 'Reseller' with the domain underneath, 'Email', 'Accounts' as used over limit, 'Disk allocated' as a small meter bar, 'Privileges', 'Shared IP', 'Last login' and 'Status' pills reading Active, Privileges suspended or Not configured, each row with a '...' menu of 'Edit', 'Privileges & nameservers', 'IP delegation', 'Accounts', 'Usage', 'Suspend privileges' and 'Remove reseller status'; a closing muted line linking the bulk pages.
```

Sub-screens (5):

- **Add a reseller modal**

  ```text
  Large modal dialog 'Add a reseller' with a switch 'Create from an existing hosting account', fields 'Account' or 'Username', 'Email', 'Password', 'Privileges (ACL list)', 'Shared IP', a 'Limits' section with 'Maximum accounts', 'Disk space (MB)', 'Bandwidth (MB per month)' and two overselling switches, a 'Nameservers' section and an 'Allowed packages' checklist. Buttons 'Cancel' and 'Create reseller'.
  ```

- **Add a reseller success state**

  ```text
  Same large modal showing a green success banner 'reseller1 created. No password was given, so one was generated. It is shown once; the reseller must change it at first login.' and a key and value list 'Username', 'Initial password', 'Privileges', 'Owned accounts', with a single primary button 'Done'.
  ```

- **Edit reseller modal**

  ```text
  Large modal dialog 'Edit reseller reseller1' showing a key and value list 'Status', 'Accounts', 'Disk allocated / used', 'Delegated IPs', 'Hosting account', then fields 'Email', 'Shared IP', 'Notes', sections 'Limits', 'Nameservers', 'Allowed packages' and 'Privileges', a note 'Changes apply when you save.' and buttons 'Cancel' and 'Save'.
  ```

- **Confirm suspend privileges**

  ```text
  Confirmation dialog 'Suspend reseller1's reseller privileges?' with body text that the reseller can no longer sign in to the panel or use the API while its hosting accounts keep running. Buttons 'Cancel' and a destructive 'Suspend'.
  ```

- **Confirm remove reseller status**

  ```text
  Destructive confirmation dialog 'Remove reseller status from reseller1?' saying privileges, limits and delegated IPs are removed and the owned accounts move to root while the login stays, with a 'Type reseller1 to confirm' input and buttons 'Cancel' and 'Reset reseller'.
  ```

#### Reset Resellers

`/resellers/reset-resellers` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Reset Resellers', breadcrumb Home > Resellers > Reset Resellers, favourite star, description 'Strips reseller privileges without touching hosting accounts: the accounts a reseller owns are reassigned to root, its ACLs, limits and delegated IPs are cleared and its login becomes a plain user. Re-add it in Reseller Center to restore.' Body: three stat tiles 'Resellers', 'Selected', 'Accounts affected'; a card with a selectable table whose toolbar holds a destructive button 'Reset selected (2)' and a quieter destructive 'Reset all resellers', columns 'Reseller', 'Email', 'Accounts', 'Disk used', 'Delegated IPs' and 'Status' pills, a row '...' menu with 'Reset', empty state 'Resellers will be listed here once added in Reseller Center.'; a card 'Last reset' subtitle 'Accounts moved to root' with a dense table 'Reseller', 'Result' and 'Details'.
```

Sub-screens (1):

- **Confirm reset resellers**

  ```text
  Destructive confirmation dialog 'Reset 2 reseller(s)?' saying privileges, limits, nameservers and delegated IPs are removed and the accounts move to root while hosting accounts and logins are kept, with a 'Type RESET to confirm' input and buttons 'Cancel' and 'Reset resellers'.
  ```

#### Show Reseller Accounts

`/resellers/show-reseller-accounts` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Show Reseller Accounts', breadcrumb Home > Resellers > Show Reseller Accounts, favourite star, description 'Every hosting account owned by a reseller, with its package, address and usage.' No header action buttons. Body: card 'Select a reseller' with a 'Reseller' dropdown; five stat tiles 'Accounts', 'Suspended', 'Disk used', 'Bandwidth used', 'Account limit'; card 'Accounts owned by reseller1' with a header dropdown offering 'All accounts', 'Active only' and 'Suspended only', and a paged sortable table with search box 'Search user, domain or email' and columns 'Domain' as a link, 'User', 'Package', 'IP', 'Disk', 'Bandwidth', 'Contact', 'Created' and 'Status' pills, each row with a '...' menu of 'Modify' and 'Change owner'.
```

#### View Reseller Usage and Manage Account Status

`/resellers/view-reseller-usage-and-manage-account-status` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'View Reseller Usage and Manage Account Status', breadcrumb Home > Resellers > View Reseller Usage and Manage Account Status, favourite star, description 'Compares each reseller's allocated and consumed resources with its limits, and lets you suspend or unsuspend its accounts in place.' Body: card 'All resellers' with a table of 'Reseller', 'Accounts', 'Disk allocated' and 'Bandwidth allocated' as meter bars, 'Disk used', 'Bandwidth used' and 'Status' pills; card 'Inspect a reseller' with a dropdown; card 'reseller1: usage against limits' with a small 'Edit limits' button, an amber banner 'Reseller privileges are suspended. The hosting accounts below still run.', four stat tiles 'Accounts', 'Suspended accounts', 'Disk used', 'Bandwidth used' and a list 'Disk allocated', 'Bandwidth allocated', 'Overselling', 'Over limits'; card 'Accounts' with a table 'Domain', 'Package', 'Disk', 'Bandwidth', 'Status', row menus 'Suspend' or 'Unsuspend', and a 'Refresh' button.
```

Sub-screens (1):

- **Confirm suspend account**

  ```text
  Confirmation dialog 'Suspend acme?' with body text saying the domain stops serving and its login is locked until unsuspended. Buttons 'Cancel' and a destructive 'Suspend'.
  ```

### 7. Service Configuration

10 screens. Sidebar tile colour for this category is used on its tool cards.

#### Apache Configuration

`/service-configuration/apache-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Apache Configuration', breadcrumb Home > Service Configuration > Apache Configuration, favourite star, description 'Global Apache directives rendered into a managed include, the MPM, mod_status and an include editor. Every save runs the configuration test first and rolls back if Apache rejects it.' Header actions: 'Reload' and a red 'Restart'. Body: card 'Server' with a 'Last apply' pill and a key-value list reading Unit, Version, Layout, Running MPM, Listening on, Domain logs, Managed include, Virtual hosts with total, applied, pending and failed counts beside a small 'Re-render all' button, PHP-FPM, mod_status worker counters, Loaded modules. Below, a segmented control 'Global directives', 'MPM / workers', 'Include editor'; the first shows a two-column field grid 'Timeout (s)', a 'KeepAlive' switch, 'MaxKeepAliveRequests', 'KeepAliveTimeout (s)', 'ServerTokens', 'ServerSignature', 'TraceEnable', 'HostnameLookups', 'ServerAdmin', 'FileETag', 'LimitRequestBody (bytes)', 'Default PHP-FPM version for new accounts', then a multi-line 'DirectoryIndex' box and a switch 'Enable mod_status at /server-status for localhost'. Sticky bottom bar with 'Save and apply' and 'Reset'. An install notice appears when Apache is missing.
```

Sub-screens (4):

- **MPM / workers tab**

  ```text
  Tab panel 'MPM / workers' with the note that values are rendered inside IfModule blocks. A 'MPM module' picker listing event, worker and prefork, then a grid of 'StartServers', 'ServerLimit', 'MaxRequestWorkers', 'MaxConnectionsPerChild', 'MinSpareThreads', 'MaxSpareThreads', 'ThreadsPerChild', and an amber banner warning that mod_php is loaded.
  ```

- **Include editor tab**

  ```text
  Tab panel card 'Custom directives', subtitle saying they are appended verbatim to the managed include and a rejected save rolls back. A tall monospace text area, a 'Test configuration' button, a green 'Syntax OK' or red 'Configuration rejected' banner with log output, and a collapsible 'Current managed include on disk'.
  ```

- **Switch MPM confirmation**

  ```text
  Confirmation dialog 'Switch MPM?' warning that changing the MPM restarts Apache, every site is briefly unavailable and mod_php only works with prefork. Buttons: a red 'Switch and restart' and Cancel.
  ```

- **Restart Apache confirmation**

  ```text
  Confirmation dialog 'Restart Apache?' with the message 'Open connections are dropped while Apache restarts.' Buttons: a red 'Restart' and Cancel.
  ```

#### Log Rotation Configuration

`/service-configuration/cpanel-log-rotation-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Log Rotation Configuration', breadcrumb Home > Service Configuration > Log Rotation Configuration, favourite star, description 'Rotation policy for panel, account and web server logs, written as managed files under /etc/logrotate.d and validated with logrotate -d before they are kept.' No header actions. Body: card 'Policy' with a 'Last apply' pill, a three-column grid 'Frequency', 'Keep (rotations)' and 'Rotate when larger than', then switches 'Compress rotated logs (gzip)', 'Delay compression by one cycle', 'Ignore missing files (missingok)', 'Skip empty logs (notifempty)', 'Date suffix instead of numbers (dateext)' and 'Reload Apache after rotating account/web logs'. Card 'Managed policies' holds a table with columns Policy, Paths, Enabled, On disk and a trailing actions column; rows read 'Panel logs', 'Account logs' and 'Web server logs' with monospace paths, a switch, a green 'written' or grey 'not written' pill, and small 'Run' and 'Force' buttons; a log output block follows a run. Card 'Preview' shows collapsible generated stanzas. Sticky bar 'Save and write policies' and 'Reset'.
```

Sub-screens (1):

- **Force-rotate confirmation**

  ```text
  Confirmation dialog titled 'Force-rotate account logs?' with the message 'Every matching log file is rotated now regardless of size or age.' Buttons: a primary 'Rotate now' and Cancel.
  ```

#### Web Disk Configuration

`/service-configuration/cpanel-web-disk-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Web Disk Configuration', breadcrumb Home > Service Configuration > Web Disk Configuration, favourite star, description 'Web Disk lets an account mount its home directory over WebDAV. Each account runs its own service published under the server hostname site; the port settings below are kept for compatibility and do not drive those services.' No header actions. Body: card 'Web Disks of the accounts' with a table of Account, Login, State, Port, Address and Changed, the state shown as an 'On', 'Off', 'No password' or 'Not running' pill, and an empty state 'No account has set up Web Disk yet' explaining a disk appears once an account sets a Web Disk password. A blue banner reads 'Legacy settings. No daemon listens on the ports below.' Card 'Service' with a switch 'Enable Web Disk' and a grid 'Plain port', 'SSL port', 'Idle timeout (minutes)', 'Maximum upload (MB)' and 'Who may use Web Disk'. Card 'Security' with switches 'Require SSL', 'Allow Digest authentication' and 'Answer unauthenticated OPTIONS/PROPFIND', plus an amber warning when SSL is not required. Sticky bar 'Save settings' and 'Reset'.
```

#### Panel Web Services Configuration

`/service-configuration/cpanel-web-services-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Panel Web Services Configuration', breadcrumb Home > Service Configuration > Panel Web Services Configuration, favourite star, description 'Tuning for the panel's own HTTP services (ports 2086/2087 and the JSON API): token and session lifetimes, request limits, CORS origins and logging.' No header actions. Body: a blue banner 'Stored, not applied yet.' Card 'API' with a switch 'JSON API for API tokens', a grid of 'API token lifetime (minutes)', 'Browser session timeout (minutes)', 'Rate limit (requests / minute / IP)', 'Maximum concurrent requests' and 'Request log retention (days)', then a multi-line 'Allowed cross-origin origins' box. Card 'Transport' with switches 'Compress API responses (gzip)', 'Listen on IPv6 as well as IPv4' and 'Expose the panel version in the Server header'. Sticky bar 'Save settings' and 'Reset'. Last card 'Calendars (Radicale)' with 'Unpublish', 'Publish' and 'Install' actions and a key-value list of Status, Server, Address, Apache, Answers, Configuration, DAV logins and Last apply.
```

Sub-screens (2):

- **Unpublish calendar confirmation**

  ```text
  Confirmation dialog 'Unpublish the calendar server?' explaining the /dav/ URL stops answering while Radicale keeps running on loopback and the DAV passwords stay. Buttons: a red 'Unpublish' and Cancel.
  ```

- **Radicale installation progress**

  ```text
  Card 'Radicale installation' appearing under the calendar card, subtitle linking to Task Queue Monitor, showing a live streaming job log with a progress indicator and the finished status line.
  ```

#### Exim Configuration Manager

`/service-configuration/exim-configuration-manager` · config

```text
Desktop admin panel screen, 1440px. Page header 'Exim Configuration Manager', breadcrumb Home > Service Configuration > Exim Configuration Manager, favourite star, description 'Server-wide Exim policy: RBLs, SPF/DKIM verification, connection and rate limits, dictionary attack protection, message size and SMTP AUTH. Rendered into panel-managed fragments, validated with exim -bV and reloaded.' No header actions. Body: card 'Mail server' with a 'Last apply' pill and a key-value list of Unit, Version, Compiled-in checks, Layout, Main options, RCPT ACL chain, DATA ACL, TLS policy, Queue and Email category, each with green or amber state pills. Card 'Virtual mailboxes' with 'Apply' and red 'Disable' buttons and rows Live, Enabled, Dovecot, the three Exim fragments, Rendered check and Submission ports, plus an information banner with manual include lines. Then a segmented control 'RBLs and verification', 'Limits and rate limiting', 'Dictionary attack protection', 'Auth, size and logging', 'Outbound and IPv6', 'Generated config'; the first shows switches for rejecting RBL-listed hosts and domains, 'IP blacklists (dnslists)' and 'Domain blacklists' list boxes, and switches 'Verify SPF', 'Reject on SPF hard fail', 'Verify DKIM signatures', 'Reject on DKIM fail', 'Require reverse DNS (PTR) for sending hosts', 'Verify the sender address is routable' and 'Require HELO/EHLO before MAIL FROM'. Sticky bar 'Save and apply to Exim' and 'Reset'.
```

Sub-screens (7):

- **Apply virtual mailboxes confirmation**

  ```text
  Confirmation dialog 'Apply virtual mailboxes?' explaining it writes the Dovecot passdb/userdb include and the Exim router, transport and authenticator fragments, validates them and reloads both daemons. Buttons: a primary 'Apply' and Cancel.
  ```

- **Disable virtual mailboxes confirmation**

  ```text
  Confirmation dialog 'Disable virtual mailboxes?' warning that panel-created mailboxes stop receiving mail and their logins stop working until virtual mail is applied again. Buttons: a red 'Disable' and Cancel.
  ```

- **Limits and rate limiting tab**

  ```text
  Tab panel with a grid of 'Max simultaneous SMTP connections', 'Max connections per host' and 'Messages per connection before queueing', a switch 'Slow down busy clients', then 'MAIL commands before delay', 'Initial MAIL delay (s)', 'RCPT commands before delay' and 'Initial RCPT delay (s)'.
  ```

- **Dictionary attack protection tab**

  ```text
  Tab panel explaining it stops clients probing for valid mailboxes. A switch 'Enable dictionary attack protection', a grid of 'Unknown SMTP commands before drop', 'Failed recipients before drop', 'Delay before drop (s)' and 'Max recipients per message', and a switch 'Reject the whole message when the recipient cap is exceeded'.
  ```

- **Auth, size and logging tab**

  ```text
  Tab panel with 'Maximum message size (MB)', a switch 'Only advertise SMTP AUTH over TLS', a switch 'Submission ports 465/587', and an 'Extra log selectors' checkbox group listing SMTP connections, Subjects, TLS cipher, Received recipients, Sender on delivery, Incomplete transactions, All parents, Command arguments, Protocol errors and Syntax errors.
  ```

- **Outbound and IPv6 tab**

  ```text
  Tab panel with card 'Outbound relay' carrying a state pill, a switch 'Relay outbound mail through a smarthost', fields 'Relay host' and 'Port', switches 'Require TLS to the relay' and 'Authenticate to the relay' with 'Login' and 'Password' fields, then card 'IPv6' with a picker 'IPv6 for outgoing mail'.
  ```

- **Generated config tab**

  ```text
  Tab panel of three read-only cards 'Main options', 'RCPT ACL chain' and 'DATA ACL fragment', each subtitled with the file path and filled with a monospace generated configuration block, closing with the note that the preview shows the last saved settings.
  ```

#### FTP Server Selection

`/service-configuration/ftp-server-selection` · config

```text
Desktop admin panel screen, 1440px. Page header 'FTP Server Selection', breadcrumb Home > Service Configuration > FTP Server Selection, favourite star, description 'Choose which FTP daemon serves accounts (Pure-FTPd, ProFTPD or vsftpd) and tune passive ports, TLS, limits and chroot. The alternatives are stopped and disabled so only one listens on port 21.' No header actions. Body: card 'FTP server' with a 'Last apply' pill, a key-value list of 'Selected in panel', 'Running now' and 'Package manager', then a radio list of the three daemons each with a 'running', 'installed' or 'not installed' pill and its systemd unit, plus a final 'Disable FTP' choice, an 'Install … first' switch when the daemon is absent, and a primary apply button. Card 'Daemon settings' with a grid of 'Passive port range: from', 'Passive port range: to', 'Passive address (NAT)', 'TLS', 'Max clients', 'Max clients per IP' and 'Idle timeout (minutes)', switches 'Jail users to their home directory (chroot)' and 'Allow anonymous logins', and a collapsible read-back of effective values. Sticky bar 'Save and apply to the FTP daemon' and 'Reset'.
```

Sub-screens (2):

- **Change FTP server confirmation**

  ```text
  Confirmation dialog 'Change FTP server?' saying this will switch to the chosen daemon, that alternatives are stopped and disabled and that active FTP sessions are dropped. Buttons: a primary 'Apply' and Cancel.
  ```

- **Package installation progress**

  ```text
  Card 'Package installation' under the server card, subtitle linking to Task Queue Monitor, with a streaming job log and a finished notice telling the operator to select the daemon again, followed by a list of systemctl steps each with an ok or failed pill.
  ```

#### Mailserver Configuration

`/service-configuration/mailserver-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Mailserver Configuration', breadcrumb Home > Service Configuration > Mailserver Configuration, favourite star, description 'Dovecot IMAP/POP3 settings: protocols, connection and process limits, SSL requirements and mailbox location. Written to conf.d/97-whm-mailserver.conf, validated with doveconf -n and reloaded.' No header actions. Body: card 'Dovecot' with a 'Last apply' pill and a key-value list of Unit, Version, Configuration test, Effective protocols, Effective ssl, mail_location and Managed include with green or pending pills. Card 'Protocols' with checkboxes 'IMAP (143 / 993)', 'POP3 (110 / 995)', 'LMTP (local delivery from Exim)' and 'ManageSieve (filters)'. Card 'Connections' with 'Max connections per user per IP', 'Process limit', 'Client limit' and 'IMAP IDLE notify interval (minutes)'. Card 'SSL' with pickers 'ssl' and 'Minimum TLS protocol', fields 'Cipher list (ssl_cipher_list)' and 'TLS 1.3 cipher suites (ssl_cipher_suites)' and switches for preferring the server's cipher order and disabling plain-text authentication. Card 'Mailboxes' with 'mail_location', 'Mailbox format for new accounts', 'POP3 UIDL format' and 'Login greeting'. Card 'Preview' with the generated file. Sticky bar 'Save and apply to Dovecot' and 'Reset'.
```

Sub-screens (1):

- **Disable IMAP confirmation**

  ```text
  Confirmation dialog 'Disable IMAP?' with the message 'Mail clients using IMAP lose access until it is enabled again.' Buttons: a red 'Disable IMAP' and Cancel.
  ```

#### Manage Service SSL Certificates

`/service-configuration/manage-service-ssl-certificates` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Service SSL Certificates', breadcrumb Home > Service Configuration > Manage Service SSL Certificates, favourite star, description 'Certificates used by Exim, Dovecot, the FTP server, Apache's default SSL host and the panel itself. Install a signed certificate or reset a service to a fresh self-signed one for the server hostname.' No header actions. Body: one card 'Service certificates', subtitled with the server hostname and the storage directory, carrying a small 'Self-signed validity (days)' number field in its header. Inside, a table with columns Service, Daemon, Certificate, Expires, Issuer and a trailing actions column; the Service cell shows the label over its monospace directory, Daemon shows an 'installed' or 'not installed' pill, Certificate a 'signed' or 'self-signed' pill with the subject or a 'none installed' pill, Expires a green, amber or red pill with days remaining and the date, and each row ends with small 'Install' and red 'Reset to self-signed' buttons. A footnote points per-domain certificates at Manage SSL Hosts and explains the panel certificate takes effect after a panel restart. A notice replaces the actions when openssl is missing.
```

Sub-screens (2):

- **Install certificate modal**

  ```text
  Large modal dialog 'Install certificate for Dovecot' with monospace text areas 'Certificate (PEM)' and 'Private key (PEM)', both required, an optional 'CA bundle / chain (PEM, optional)' area, the note that the daemon is reloaded after the files are written, and footer buttons Cancel and a primary 'Install'.
  ```

- **Reset to self-signed confirmation**

  ```text
  Confirmation dialog 'Reset Dovecot to a self-signed certificate?' saying a new self-signed certificate for the server hostname replaces the current one and clients will show a trust warning. Buttons: a red 'Reset' and Cancel.
  ```

#### Nameserver Selection

`/service-configuration/nameserver-selection` · config

```text
Desktop admin panel screen, 1440px. Page header 'Nameserver Selection', breadcrumb Home > Service Configuration > Nameserver Selection, favourite star, description 'Choose the DNS server software (BIND or PowerDNS) and this server's role. Switching enables and starts the chosen daemon and disables the other; zone management lives under DNS Functions.' No header actions. Body: one card 'Nameserver' with a 'Last apply' pill and a key-value list of 'Selected in panel', 'Running now' with an active or inactive pill, 'DNS Functions category' with a loaded pill, 'BIND layout', 'Zones in panel' and 'Package manager'. Under it a 'Role' picker offering Master (authoritative), Slave (secondary) and Standalone with help text, then a radio list of the DNS daemons each showing a 'running', 'installed' or 'not installed' pill and its systemd unit, a final 'Disable DNS service' choice, an install switch when the daemon is absent, and a primary apply button. A closing note links zone editing to DNS Zone Manager.
```

Sub-screens (2):

- **Change nameserver confirmation**

  ```text
  Confirmation dialog 'Change nameserver software?' saying the chosen daemon is enabled and started, the other is stopped and disabled, and zones already written stay on disk. Buttons: a primary 'Apply' and Cancel.
  ```

- **Package installation progress**

  ```text
  Card 'Package installation' below the nameserver card, subtitle linking to Task Queue Monitor, with a streaming job log, and once finished a list of systemctl steps each carrying an ok or failed pill.
  ```

#### Service Manager

`/service-configuration/service-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Service Manager', breadcrumb Home > Service Configuration > Service Manager, favourite star, description 'Choose which services start at boot and which the panel monitors and restarts automatically when they fail. The switches apply once a service is installed.' No header actions. Body: one full-width card holding a dense table with columns 'Service', 'Status', 'Start at boot', 'Monitor', 'Auto-restart' and a trailing row-menu column. The Service cell shows the display name over a small monospace systemd unit, or the text 'looks for:' with the candidate unit names when nothing is installed; Status is a pill reading 'Up', 'Down' or 'Not installed'; the last three columns are switches, greyed out for services that are not installed. The row '...' menu offers 'Restart', then 'Stop' in red for a running service or 'Start' for a stopped one.
```

Sub-screens (1):

- **Stop service confirmation**

  ```text
  Confirmation dialog 'Stop Exim?' with the message 'Clients using this service will be disconnected.' Buttons: a red 'Stop' and Cancel.
  ```

### 8. Locales

7 screens. Sidebar tile colour for this category is used on its tool cards.

#### Configure Application Locales

`/locales/configure-application-locales` · config

```text
Desktop admin panel screen, 1440px. Page header 'Configure Application Locales', breadcrumb Home > Locales > Configure Application Locales, favourite star, description 'Default and available interface languages.' No header actions. Body: card 'Interface languages', subtitle saying the default applies to everyone who has not picked a language, enabled locales are the ones users may choose, and the default is always enabled; inside it a required 'Default locale' dropdown, then a table with columns 'Locale', 'Translated' and 'Available to users' where each row shows the language name beside its code, a small 'Built-in' pill, a thin progress meter reading '412/540 · 76%', and a switch labelled 'Default', 'Enabled' or 'Disabled'; buttons 'Save', 'Reset' and 'View available locales'. Below, card 'Your preference in this browser' with one dropdown 'Interface language for this browser' set to 'Server default (en)'.
```

#### Copy a Locale

`/locales/copy-a-locale` · form

```text
Desktop admin panel screen, 1440px. Page header 'Copy a Locale', breadcrumb Home > Locales > Copy a Locale, favourite star, description 'Duplicate a locale to customise it.' No header actions. Body: one card 'Duplicate a locale', subtitle explaining the copy starts with every string of the source and stays disabled until enabled under Configure Application Locales. A two-column field grid holds a required 'Source locale' dropdown, a required 'New locale code' text box with placeholder 'For example es_mx' and help 'A two or three letter language code, optionally followed by _ and a region', and 'Display name' with help 'Shown to users in the language picker.' Under it a key and value list 'Source', 'Strings in source', 'Progress' with a translation meter. Buttons 'Copy locale' and 'Cancel'. Show the inline error 'That code is already installed' under the code box.
```

#### Delete a Locale

`/locales/delete-a-locale` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Delete a Locale', breadcrumb Home > Locales > Delete a Locale, favourite star, description 'Remove a custom locale.' No header actions. Body: one card 'Custom locales', subtitle 'The built-in English locale cannot be deleted, and the current default must be changed under Configure Application Locales before it can go', filled edge to edge by a table with columns 'Code' (monospace), 'Name' (bold), 'State' (small pills reading 'Default', 'Enabled' or 'Disabled'), 'Translated' (progress meter with a count and percentage) and 'Updated' (date). Each row ends in a three-dot menu with 'Download XML' and a red 'Delete', greyed out on the default row. Empty state: 'There are no custom locales to delete. Locales created by copying, importing or editing will appear here.' Small muted links below: 'Back to available locales' and 'change the default'.
```

Sub-screens (1):

- **Delete locale confirmation**

  ```text
  Confirmation dialog titled 'Delete locale "Espanol" (es)?' with the message 'All 412 translated strings are removed permanently. Download its XML first if you may want it back.', a text box asking the reader to type the locale code 'es' to confirm, and the buttons 'Delete locale' in red and 'Cancel'.
  ```

#### Edit a Locale

`/locales/edit-a-locale` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'Edit a Locale', breadcrumb Home > Locales > Edit a Locale, favourite star, description 'Edit translated strings.' Header actions: small buttons 'Copy' and 'Download XML'. Body: card 'Locale' subtitled that the built-in English locale is the reference and cannot be edited, holding a 'Locale' dropdown and a 'Display name' text box side by side, with state pills and a translation meter beneath. Then card 'Strings' with 'Save (12)' and 'Discard' buttons in its corner, a segmented control 'All', 'Untranslated', 'Translated', 'Unsaved', 'Not in catalog' each with a count badge, a search box 'Search keys, English text or translations…', and a scrolling three-column table 'Key' (monospace, some rows tagged 'Not in catalog'), 'English', and the locale's own name holding an editable text box per row; a footer reads '1–50 of 540' with 'Previous', 'Page 1 of 11', 'Next'.
```

#### Locale XML Download

`/locales/locale-xml-download` · form

```text
Desktop admin panel screen, 1440px. Page header 'Locale XML Download', breadcrumb Home > Locales > Locale XML Download, favourite star, description 'Export a locale.' No header actions. Body: one card 'Export a locale as XML', subtitle saying the file holds every translated string of the locale as string elements and can be edited offline then re-imported with Locale XML Upload. Inside: a 'Locale' dropdown, then a key and value list reading 'Name', 'Translated' (a progress meter with the count, percentage and a muted '+3 extra') and 'File' ('es.xml · 48213 bytes'). Buttons: a filled 'Download es.xml' with a download arrow icon, and 'Preview'. Under them a read-only monospace text area about eighteen rows tall showing the XML document.
```

#### Locale XML Upload

`/locales/locale-xml-upload` · form

```text
Desktop admin panel screen, 1440px. Page header 'Locale XML Upload', breadcrumb Home > Locales > Locale XML Upload, favourite star, description 'Import a locale.' Header action: ghost button 'Download an existing locale'. Body: one card 'Import a locale from XML', subtitle saying the file is validated before anything is written and the built-in English locale cannot be overwritten. A field grid holds 'Locale file' with an upload-icon button 'Choose .xml file' and the help 'A .xml file up to 2 MB, or paste the document below', plus 'Locale code (optional)' and 'Display name (optional)' text boxes placeholdered 'From the file'. Below, a tall monospace 'XML document' text area, then radio buttons 'When the locale already exists' offering 'Merge', 'Replace' and 'Create only' each with a sentence of explanation. A 'Validation result' panel lists 'Locale', 'Action', 'Strings in file', 'Added / changed / removed', 'Keys not in the English catalog', 'Coverage after import'. Buttons 'Validate' and 'Import'.
```

Sub-screens (2):

- **Invalid XML error banner**

  ```text
  Same screen with a red error banner above the buttons, warning-triangle icon, heading 'The locale XML is not valid' and a bulleted list of parser messages naming the offending lines and missing key attributes.
  ```

- **Import confirmation**

  ```text
  Confirmation dialog titled 'Import this locale?' with the message '"es" exists: 42 string(s) added, 7 changed, 2 removed.' and the buttons 'Import' and 'Cancel'.
  ```

#### View Available Locales

`/locales/view-available-locales` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'View Available Locales', breadcrumb Home > Locales > View Available Locales, favourite star, description 'All installed locales.' Header actions: 'Refresh' and a filled 'Configure'. Body: card 'Installed locales' subtitled '4 locale(s) · default "en" · 540 base strings in the English catalog. Disabled locales are kept but not offered to users.', holding a full-width table with columns 'Code', 'Name', 'State' (pills 'Built-in', 'Default', 'Enabled' or 'Disabled'), 'Translated' (progress meter), 'Source' and 'Updated', each row ending in a menu with 'Edit', 'Copy' and 'Download XML'. Second card 'Operating system locale', subtitle 'What the host itself runs with (LANG and LC_* from the system locale file).', a small 'Re-read' button, a key and value list 'Locale tools (glibc)' with an Installed pill, 'System language', 'Config file', 'Panel default locale', a small Variable and Value table, and an install-package block.
```

### 9. Backup

4 screens. Sidebar tile colour for this category is used on its tool cards.

#### Backup Configuration

`/backup/backup-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Backup Configuration', breadcrumb Home > Backup > Backup Configuration, favourite star, description 'Schedule nightly account archives (home directory, mail, databases, DNS zones and metadata), keep daily/weekly/monthly copies and send them to remote destinations.' Header action: 'Run backup now'. Body: card 'Status' with stat tiles 'Backups', 'Accounts included', 'Last run' above a key/value list 'Next scheduled run', 'Local directory', 'Last run result', 'Tools'; card 'Global settings' with a 'Schedule' dropdown and switches 'Enable scheduled backups', 'Strict mode', 'Skip suspended accounts', 'Notify contacts when a run fails'; card 'Retention' with 'Daily backups to keep', 'Weekly backups to keep', 'Monthly backups to keep'; card 'What to back up' with include switches, 'Excluded paths' and 'Compression level (gzip 1–9)'; card 'Local storage'; sticky 'Save' and 'Reset'; card 'Additional destinations' with an 'Add destination' button and table 'Name', 'Type', 'Target', 'Enabled', 'Last test'; card 'Recent runs' with 'Started', 'Kind', 'Status', 'Accounts', 'Size', 'Uploads / pruned', 'Error', 'By'. Enabled and disabled status pills, warning banner that tar and gzip are not installed.
```

Sub-screens (5):

- **Add destination modal**

  ```text
  Modal dialog 'Add destination', wide. Fields 'Name', an 'Enabled' switch, a 'Type' dropdown listing 'Local directory', 'FTP / FTPS', 'SFTP', 'WebDAV', 'S3-compatible', then type fields 'Bucket', 'Region', 'Endpoint (optional)', 'Key prefix (folder)', 'Access key', 'Secret key' and switches 'Path-style addressing', 'Skip TLS certificate verification'. A key/value row 'Upload method'. Footer buttons 'Cancel', 'Test connection', 'Add'.
  ```

- **Edit destination modal with test result**

  ```text
  Modal dialog 'Edit offsite-s3' with the same fields, the 'Type' dropdown disabled and secret fields helped by 'Leave blank to keep the stored value'. A green success banner above the form reading the connection test message with its duration in milliseconds. Footer buttons 'Cancel', a disabled 'Test connection', and 'Save'.
  ```

- **Run backup confirmation**

  ```text
  Confirmation dialog 'Run a backup now?' explaining that every included account is archived to the local backup directory and copied to the enabled destinations and that this runs in the background. Buttons 'Cancel' and 'Run backup'.
  ```

- **Delete destination confirmation**

  ```text
  Destructive confirmation dialog 'Delete destination offsite-s3?' saying archives already uploaded there are not deleted but the panel can no longer fetch or prune them. Buttons 'Cancel' and a red 'Delete'.
  ```

- **Backup run progress**

  ```text
  Progress state inside the 'Status' card: a live progress bar with a percentage and a scrolling timestamped log of the running backup job, ending with a toast reading the finished run's ok and failed counts.
  ```

#### Backup Restoration

`/backup/backup-restoration` · form

```text
Desktop admin panel screen, 1440px. Page header 'Backup Restoration', breadcrumb Home > Backup > Backup Restoration, favourite star, description 'Restore a complete account from one of its archives: home directory, databases and their users, DNS zones and mail routing. A terminated account is recreated from the metadata stored in the archive.' No header actions. Body: card 'Choose the account and backup' with a 'Filter' input, an 'Account' dropdown and a radio-select table 'Backup date', 'Archive', 'Size', 'Class', 'Copies' with local and remote-only pills, plus a 'Fetch archive from destination' button; card 'What to restore' with a key/value list 'Archive', 'Created', 'Home directory', 'Databases', 'DNS zones', 'Metadata', 'Other domains', 'SHA-256' and switches 'Home directory and mail', 'Overwrite files that exist', 'Databases, users and grants', 'DNS zones', 'Mail routing', 'Recreate the account if it was terminated', and a red 'Restore account' button; card 'Import an archive' with 'Archive path' and 'Register archive'; card 'Restore history' with columns 'Requested', 'Account', 'Kind', 'Status', 'Steps', 'Error', 'By'.
```

Sub-screens (3):

- **Restore account confirmation**

  ```text
  Destructive confirmation dialog 'Restore alice from 12 March 2026 02:00?' explaining that home files are replaced by the archived versions, databases are re-imported and DNS zones reloaded, with a text box asking the operator to type the account name to confirm. Buttons 'Cancel' and a red 'Restore'.
  ```

- **Remote-only archive warning**

  ```text
  Alternate state of the backup picker: the selected row shows a 'remote only' pill and a warning banner below the table reads that this archive is not on local disk and must be fetched from a destination before browsing or restoring it, with a 'Fetch archive from destination' button.
  ```

- **Restore progress**

  ```text
  Progress state at the bottom of the 'What to restore' card: a live progress bar and timestamped job log of the running restore, with the restore history table below refreshing to show the new row and its per-step pills.
  ```

#### Backup User Selection

`/backup/backup-user-selection` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Backup User Selection', breadcrumb Home > Backup > Backup User Selection, favourite star, description 'Choose which accounts the scheduled backup archives. Accounts without an explicit choice follow the default below.' No header actions. Body: card 'Default for new accounts' holding a switch 'Include accounts that have no explicit setting' and a 'Show' dropdown with 'All accounts', 'Included only', 'Excluded only', under a muted line counting included and excluded accounts and linking to Backup Configuration. Below it a full-width table with a search box 'Search by user, domain or owner', checkbox selection, toolbar buttons 'Include selected (0)' and 'Exclude selected', and columns 'Account', 'Owner', 'Backups', 'Last backup'. Rows show enabled or disabled pills, a muted 'default' pill, a 'suspended' pill, and a row menu with 'Exclude' or 'Include'. Empty state 'Accounts matching the search and filter will appear here.'
```

#### File and Directory Restoration

`/backup/file-and-directory-restoration` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'File and Directory Restoration', breadcrumb Home > Backup > File and Directory Restoration, favourite star, description 'Browse an account archive and restore individual files or directories into the account's home directory with the right ownership.' No header actions. Body: card '1. Choose the account and the backup date' with a 'Filter' input, an 'Account' dropdown and a radio table 'Backup date', 'Archive', 'Size', 'Class', 'Copies'; card '2. Pick files and directories', subtitle 'Directories are restored with everything inside them.', a count of selected items in its corner, a path breadcrumb across the archive, a 'Filter this directory' input, and a checkbox file table with columns 'Name', 'Size', 'Files', 'Modified', 'Owner', 'Mode' plus a parent-directory row; a 'Selected for restore' list, a switch 'Overwrite existing files' and a red 'Restore selected' button; card 'Recent file restores' with 'Requested', 'Account', 'Paths', 'Status', 'Result', 'By'. Empty directory state 'This directory is empty.'
```

Sub-screens (3):

- **Restore files confirmation**

  ```text
  Destructive confirmation dialog 'Restore 3 items into /home/alice?' listing the first few selected paths and saying existing files with the same names are overwritten and ownership is set to the account. Buttons 'Cancel' and a red 'Restore'.
  ```

- **Subdirectory drill-down**

  ```text
  Drill-down view of the archive browser one level deeper: the breadcrumb now shows the home label followed by the folder name, a '..' row returns to the parent, and a muted line under the table warns that only the first entries of a large directory are shown and suggests filtering.
  ```

- **Reading the archive state**

  ```text
  Loading state of the file table: a single full-width row with a spinner and the text 'Reading the archive…' in place of the entries, with the breadcrumb, filter input and overwrite switch still visible and the restore button disabled.
  ```

### 10. Clusters

2 screens. Sidebar tile colour for this category is used on its tool cards.

#### Configuration Cluster

`/clusters/configuration-cluster` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Configuration Cluster', breadcrumb Home > Clusters > Configuration Cluster, favourite star, description 'Keep panel settings identical across servers: share chosen setting groups with peers, push them on demand or every six hours, or pull a peer's settings after reviewing the differences. Inbound pushes stay off until you turn them on under Shared settings.' Header actions: none. Body: an information banner 'What travels'. Card 'Cluster peers' with an 'Add peer' button and a table of 'Peer', 'Reachable', 'Receives config', 'Peer panel' and 'Token', each row with a '...' menu of 'Test', 'Edit', 'Share config', 'Disable' and 'Remove'. Card 'Shared settings' with a 'Save' button and a table of 'Share' checkbox, 'Group', 'Settings' and 'Keys', then switches 'Push automatically' and 'Accept settings pushed by peers' and a key/value summary. Two side-by-side cards 'Push to peers' and 'Pull from a peer' with 'Peer' and 'Group' dropdowns and buttons 'Push settings' and 'Preview differences'. Cards 'Settings tokens for peers' and 'Exchange log'. States: pills 'yes', 'no', 'applied', 'stored, daemon missing', 'failed'.
```

Sub-screens (9):

- **Add a cluster peer**

  ```text
  Modal dialog 'Add a cluster peer' with inputs 'Name' and 'Peer address', a masked 'API token' field, a 'DNS role' dropdown, and switches 'Configuration cluster', 'Verify TLS certificate' and 'Enabled'. Buttons 'Add peer' and 'Cancel'.
  ```

- **Edit peer**

  ```text
  Modal dialog 'Edit ns2' with the peer fields pre-filled, the token field labelled 'Replace API token' and placeholdered '(unchanged)', the role dropdown and the three switches. Buttons 'Save peer' and 'Cancel'.
  ```

- **Confirm remove peer**

  ```text
  Confirmation dialog 'Remove ns2?' saying the host is forgotten by both the DNS and the configuration cluster, that zones already pushed stay there and nothing is deleted on the peer. Buttons 'Remove' in red and 'Cancel'.
  ```

- **Confirm push settings**

  ```text
  Confirmation dialog 'Push Mail settings to 3 peers?' explaining each peer validates every value, refuses unknown keys and applies the rest through the owning module, and that the job log shows what was applied, stored or failed. Buttons 'Push' and 'Cancel'.
  ```

- **Differences from peer**

  ```text
  Wide modal dialog 'Differences from ns2' with a summary line of settings received, differing and refused, and a dense table of columns 'Setting', 'Here', 'Peer' and 'Applied through'. Footer buttons 'Apply 7 changes' and 'Cancel'.
  ```

- **Issue a settings token**

  ```text
  Modal dialog 'Issue a cluster token' with a required 'Name' input and an 'Expires in (days)' number input noting blank never expires and the token reaches the settings endpoints only. Buttons 'Issue token' and 'Cancel'.
  ```

- **Token issued**

  ```text
  Modal dialog 'Token issued' with a warning banner 'Copy it now — this is the only time the token is shown', a read-only monospace token field with a 'Copy' button, and a muted list of the endpoints it may call. Button 'Done'.
  ```

- **Confirm revoke token**

  ```text
  Confirmation dialog 'Revoke ns1 master?' saying the remote panel loses access immediately and its pushes are rejected until it is given a new token. Buttons 'Revoke' in red and 'Cancel'.
  ```

- **Push job progress**

  ```text
  Progress log panel inside the 'Push to peers' card streaming the running push job line by line, one block per peer, naming what was applied, what was only stored because a daemon is missing and what failed.
  ```

#### DNS Cluster

`/clusters/dns-cluster` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'DNS Cluster', breadcrumb Home > Clusters > DNS Cluster, favourite star, description 'Replicate this server's DNS zones to other servers running this panel.' Header actions: none. Body: a collapsed information banner 'How it works' about peer tokens, roles and confined endpoints. Card 'Cluster peers' with an 'Add peer' button and a table of 'Peer', 'Reachable', 'DNS role', 'Zones pushed' and 'Token', each row with a '...' menu of 'Test', 'Edit', 'Disable' and 'Remove'. Two side-by-side cards: 'Push zones now' with a 'Peer' dropdown, a 'Zones' input and a 'Push zones' button, and 'DNS cluster settings' with switches 'Push changed zones automatically', 'Accept zones pushed by peers' and 'Verify peer TLS certificates on zone pushes', a key/value block for last run and schedule, and a 'Save settings' button. Card 'Zone tokens for peers' with an 'Issue token' button and a table of 'Name', 'Acts as', 'Last used', 'Expires' and 'Issued'. Card 'Zone status per peer' with columns 'Zone', 'Peer', 'Serial sent / current', 'Status' and 'Last push'. Card 'Exchange log'. States: pills 'write-only', 'sync', 'standalone', 'stale'; an information banner 'BIND is not installed here' with an 'Install BIND' button.
```

Sub-screens (7):

- **Add a cluster peer**

  ```text
  Modal dialog 'Add a cluster peer' with inputs 'Name' and 'Peer address', a masked 'API token' field, a 'DNS role' dropdown offering write-only, sync and standalone, and switches 'Configuration cluster', 'Verify TLS certificate' and 'Enabled'. Buttons 'Add peer' and 'Cancel'.
  ```

- **Edit peer**

  ```text
  Modal dialog 'Edit ns2' with the peer fields pre-filled and the token field labelled 'Replace API token' placeholdered '(unchanged)', plus the role dropdown and three switches. Buttons 'Save peer' and 'Cancel'.
  ```

- **Confirm remove peer**

  ```text
  Confirmation dialog 'Remove ns2?' saying ns2.example.com is forgotten by both clusters, zones already pushed to it stay there and nothing is deleted on the peer. Buttons 'Remove' in red and 'Cancel'.
  ```

- **Issue a zone token**

  ```text
  Modal dialog 'Issue a cluster token' with a required 'Name' input and an 'Expires in (days)' number input noting blank never expires and that the token reaches the zone endpoints only. Buttons 'Issue token' and 'Cancel'.
  ```

- **Token issued**

  ```text
  Modal dialog 'Token issued' with a warning banner 'Copy it now', a read-only monospace token field beside a 'Copy' button, and a muted line listing the endpoints the token may call. Button 'Done'.
  ```

- **Confirm revoke token**

  ```text
  Confirmation dialog 'Revoke ns1 master?' saying the remote panel using this token loses access immediately and its pushes are rejected until it is given a new token. Buttons 'Revoke' in red and 'Cancel'.
  ```

- **Zone push progress**

  ```text
  Progress log panel inside the 'Push zones now' card streaming the running zone push, one line per zone and peer with its acknowledged serial or the peer's error answer.
  ```

### 11. System Reboot

2 screens. Sidebar tile colour for this category is used on its tool cards.

#### Forceful Server Reboot

`/system-reboot/forceful-server-reboot` · action

```text
Desktop admin panel screen, 1440px. Page header 'Forceful Server Reboot', breadcrumb Home > System Reboot > Forceful Server Reboot, favourite star, description 'Reboot immediately.' No header action buttons. Body: one card. At the top an information banner 'Forceful reboot' explaining that it reboots immediately without waiting for services to stop, that unsaved data in running services may be lost, that it should be used only when a graceful reboot hangs, and that it runs 'systemctl reboot --force' through the agent. Then a pre-flight key/value list: 'Hostname', 'Uptime', 'Load average', 'systemd', 'Reboot required by updates' with a 'Re-check' link, 'Running jobs', 'Queued jobs', 'Active transfers', 'Active backups' and 'Last panel reboot', the counts shown as status pills. Below it either a green banner 'No jobs, transfers or backups are running' or an amber one 'Work in progress will be interrupted' with a bullet list, and a table of running jobs. Then a filled input 'Reason (optional)' with placeholder 'Why is the server being rebooted?' and a red button 'Forceful reboot'. A last card 'Recent reboot requests' holds a paged table with columns 'Requested', 'Mode', 'By', 'Reason', 'Result' and 'Interrupted work'.
```

Sub-screens (4):

- **Forceful reboot confirmation**

  ```text
  Confirmation dialog in danger style titled 'Forceful Server Reboot', warning that every connection to this server will drop, the panel will be unavailable until it is back, services are not stopped cleanly and data held in memory may be lost, and listing work in progress. A text field requires typing REBOOT. Buttons 'Forceful reboot' in red and 'Cancel'.
  ```

- **Reboot accepted result**

  ```text
  Alternate state inside the card after the reboot is requested: key/value rows 'Result' with a pill reading Accepted or Rebooting, 'Mode', 'Command' in monospace, 'Reason' and 'Requested', followed by a live status banner reading 'Server is rebooting — the panel is offline. This page keeps checking…' with a health-check counter.
  ```

- **Server back online banner**

  ```text
  Alternate state: a green banner reading 'The server is back online. You can continue using the panel.' with the reboot mode, request time, number of health checks and the time it came back, plus a small button 'Reload the panel'.
  ```

- **systemd missing state**

  ```text
  Alternate state: a red banner 'systemctl is not installed' explaining the panel reboots through systemd and the request is refused without it, with the reboot button greyed out and the line 'systemctl is not installed on this server, so the panel cannot reboot it. Reboot from the console or your provider's control panel.'
  ```

#### Graceful Server Reboot

`/system-reboot/graceful-server-reboot` · action

```text
Desktop admin panel screen, 1440px. Page header 'Graceful Server Reboot', breadcrumb Home > System Reboot > Graceful Server Reboot, favourite star, description 'Stop services cleanly, then reboot.' No header action buttons. Body: one card opening with an information banner 'Graceful reboot' explaining that systemd stops every service in dependency order — web, mail, databases and the panel itself — and then reboots, that it should be used unless the server is unresponsive, and that it runs 'systemctl reboot' through the agent and records the request in the audit log and reboot history. Then a pre-flight key/value list: 'Hostname', 'Uptime', 'Load average', 'systemd', 'Reboot required by updates' with a 'Re-check' link, 'Running jobs', 'Queued jobs', 'Active transfers', 'Active backups' and 'Last panel reboot', the counts as status pills. Below, either a green banner 'No jobs, transfers or backups are running' or an amber 'Work in progress will be interrupted' with a bullet list and a table of running jobs. Then a filled input 'Reason (optional)' and a red button 'Graceful reboot'. A last card 'Recent reboot requests' holds a paged table with columns 'Requested', 'Mode', 'By', 'Reason', 'Result' and 'Interrupted work'.
```

Sub-screens (3):

- **Graceful reboot confirmation**

  ```text
  Confirmation dialog in danger style titled 'Graceful Server Reboot', warning that every connection to this server will drop and the panel will be unavailable until it is back, and listing any work in progress. A text field requires typing REBOOT. Buttons 'Graceful reboot' in red and 'Cancel'.
  ```

- **Reboot accepted result**

  ```text
  Alternate state inside the card: key/value rows 'Result' with an 'Accepted' pill, 'Mode', 'Command' in monospace, 'Reason' and 'Requested', followed by a live banner 'Reboot command accepted; waiting for the server to go down…' with a running health-check count.
  ```

- **Reboot watch timed out**

  ```text
  Alternate state: a red banner reading 'The panel has not answered for 20 minutes. Check the server console or your provider's out-of-band access.' with the reboot mode, request time and the number of health checks underneath.
  ```

### 12. Server Status

5 screens. Sidebar tile colour for this category is used on its tool cards.

#### Apache Status

`/server-status/apache-status` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Apache Status', breadcrumb Home > Server Status > Apache Status, favourite star, description 'Live web server worker status.' Header actions: an 'Auto-refresh' switch and a 'Refresh' button. Body: a row of five stat tiles 'Apache' with a Running or Down pill and the version and MPM underneath, 'Requests / sec', 'Throughput', 'Workers' showing busy and idle counts over a meter, and 'Server uptime' with lifetime request and byte totals. Then a card 'Workers', subtitled with how many slots are active and how many vhosts and clients are being served, holding a dense sortable table with columns 'Srv', 'PID', 'Acc', 'M', 'CPU', 'SS', 'Req', 'Dur', 'Conn', 'Child', 'Slot', 'Client', 'Protocol', 'VHost' and 'Request', with a 'Busy only' switch and a filter box 'Filter by vhost, client, request…' above it. Below, side by side: 'Worker scoreboard' with a grid of small coloured squares and a key table of 'Key', 'State', 'Workers' and 'Share'; 'mod_status counters'; a 'Server' card listing version, built, MPM, flavor, unit, main PID, loaded modules, mod_status pill, status probe and managed vhosts; and an 'About this page' card.
```

Sub-screens (4):

- **mod_status not available banner**

  ```text
  Alternate state: an amber banner above the worker table with a bold instruction title, a numbered list of steps to enable the status handler, links to Apache Configuration and Restart Services, and a primary button 'Enable in Apache Configuration'.
  ```

- **ExtendedStatus off state**

  ```text
  Alternate state of the 'Workers' card, subtitled 'Per-slot rows need ExtendedStatus On', with the table replaced by an amber in-card banner carrying a numbered list of steps and a note about editing the global configuration and reloading Apache.
  ```

- **No scoreboard state**

  ```text
  Alternate state of the 'Worker scoreboard' card, subtitled 'Scoreboard is available while mod_status answers', its body a muted line reading 'No scoreboard: mod_status is not loaded.' or 'No scoreboard: Apache is not running.'
  ```

- **No busy workers empty state**

  ```text
  Empty state inside the workers table reading 'No busy workers right now. Turn off "Busy only" to list idle and open slots.', with the filter box and the busy-only switch still visible above it.
  ```

#### Daily Process Log

`/server-status/daily-process-log` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'Daily Process Log', breadcrumb Home > Server Status > Daily Process Log, favourite star, description 'Every 5 minutes the panel records the busiest processes by CPU and memory. Pick a day (UTC) to see how the load developed, which programs and which users caused it. CPU figures are the %CPU column of ps: each process's lifetime average, summed, not an instantaneous reading.' Header actions: buttons 'Sample now' and 'Refresh'. Body: a filter card with dropdowns 'Day' and 'User'. Then four stat tiles 'Samples', 'Peak load (1 min)', 'Peak CPU (ps %CPU)' and 'Peak memory'. A card titled 'Usage over <date>' with a segmented control 'CPU', 'Memory', 'Load' in its corner and a multi-line time chart with a hover readout. Below, a card with three tabs 'By program', 'By user' and 'Samples', each a dense table: columns 'Program', 'User', 'Avg CPU %', 'Peak CPU %', 'Avg Mem %', 'Peak RSS', 'Seen in' and 'Longest run'; then 'User', 'Programs', 'Avg CPU %', 'Peak CPU % (one process)', 'Avg Mem %', 'Peak RSS' and 'CPU share'; then 'Time (UTC)', 'Load 1 / 5 / 15', 'CPU %', 'Mem %', 'Memory used' and 'Processes', with a row menu 'Processes'. A red 'Delete this day's log' button, and a last card 'Sampler'.
```

Sub-screens (5):

- **Sample detail modal**

  ```text
  Large modal dialog titled 'Sample at <timestamp>'. Four stat tiles 'Load', 'CPU %', 'Memory' and 'Processes', then a dense table with columns 'PID', 'User', 'CPU %', 'Mem %', 'RSS', 'Running' and 'Command', closing with a muted line saying processes that are still running can be managed under System Health › Process Manager.
  ```

- **Sampler settings card**

  ```text
  Drill-down view of the card 'Sampler', subtitled with its cron expression and next run. A switch 'Record processes every 5 minutes' with explanation, then side-by-side number fields 'Processes per sample' and 'Retention (days)', each with helper text, and a 'Save' button.
  ```

- **Delete day log confirmation**

  ```text
  Confirmation dialog titled 'Delete the process log for 2026-11-07?' with the message that the samples and their process entries are removed and that this cannot be undone. Buttons 'Delete' in red and 'Cancel'.
  ```

- **Lower retention confirmation**

  ```text
  Confirmation dialog titled 'Delete 4 days of process history?' explaining that lowering retention removes every day before the new cutoff date, with the sample count, as soon as you save, and that this cannot be undone. Buttons 'Save and delete' in red and 'Cancel'.
  ```

- **No samples empty state**

  ```text
  Empty state card titled 'No samples recorded yet' with the paragraph that the sampler runs every 5 minutes while the panel is up, the first day appears after the first run, and 'Sample now' records one immediately; the day and user filters, stat tiles, chart and tabs are absent.
  ```

#### Server Information

`/server-status/server-information` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Server Information', breadcrumb Home > Server Status > Server Information, favourite star, description 'Hardware, OS, memory and disk details.' Header action: a 'Refresh' button. Body: a row of four stat tiles 'Load average (1 / 5 / 15 min)', 'Uptime', 'Memory in use' with a meter underneath and 'Swap in use' with a meter. Below, a two-column layout. Left column: a card 'System' listing 'Hostname', 'Operating system', 'Kernel', 'CPU', 'Node.js' and 'Agent'; a card 'Memory' listing 'Total', 'Available', 'Free', 'Buffers', 'Cached', 'Swap total' and 'Swap free'. Right column: a card 'Disks' with a dense table of columns 'Mount' (mount point with the filesystem underneath), 'Size', 'Used' and 'Usage' as a percentage over a meter that turns amber past 75 percent and red past 90; and a card 'Network interfaces' with a dense table of 'Interface' and 'Addresses'. Empty row in the disks table: 'No disks reported'.
```

#### Service Status

`/server-status/service-status` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Service Status', breadcrumb Home > Server Status > Service Status, favourite star, description 'Up/down state of monitored services.' Header action: a 'Refresh' button. Body: a single borderless card holding a dense table of the monitored services with columns 'Service', 'Unit' in monospace, 'Status', 'PID', 'Memory' right-aligned, 'Restarts' right-aligned and 'Started'. The status column is a pill reading 'Up' in green, 'Down' in red or 'Not installed' in grey. Each row carries a '...' menu with 'Restart' first, then either 'Stop' in red when the service is running or 'Start' when it is not; rows for services that are not installed have no menu. Unavailable values are drawn as a muted dash. The table refreshes itself every fifteen seconds.
```

Sub-screens (1):

- **Stop service confirmation**

  ```text
  Confirmation dialog titled 'Stop Mail Server (Exim)?' with the message 'Clients using this service will be disconnected.' Buttons 'Stop' in red and 'Cancel'.
  ```

#### Task Queue Monitor

`/server-status/task-queue-monitor` · progress-log

```text
Desktop admin panel screen, 1440px. Page header 'Task Queue Monitor', breadcrumb Home > Server Status > Task Queue Monitor, favourite star, description 'Background jobs: backups, transfers, bulk changes and builds. Open a job to follow its live log.' Header action: a 'Refresh' button. Body: a card 'Jobs', subtitled with how many recent jobs are listed and how many are active, holding a dense table with columns '#', 'Type' in monospace, 'Status', 'Progress', 'Message', 'Queued' and 'Finished'. The status column is a pill reading Queued, Running, Done, Failed or Cancelled; the progress column is a narrow horizontal bar. Each row carries a '...' menu with 'View log' and, for queued jobs only, 'Cancel' in red. Empty state: 'No background jobs yet. Backups, transfers and bulk changes appear here when they are queued.' The table reloads itself every few seconds.
```

Sub-screens (1):

- **Job log modal**

  ```text
  Large modal dialog titled 'Job #184 · backup.account' showing the job's live progress: a progress bar across the top and a scrolling monospace log beneath it that streams new lines as the job runs and settles on a final status when it finishes.
  ```

### 13. Account Information

7 screens. Sidebar tile colour for this category is used on its tool cards.

#### List Accounts

`/account-information/list-accounts` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'List Accounts', breadcrumb Home > Account Information > List Accounts, favourite star, description 'Search, inspect and act on hosting accounts.'. Header actions: a primary 'Create a New Account' button with a plus icon. Body: one full-width card holding a paginated table with a search box reading 'Search user, domain, owner or email…' and sortable columns 'Domain' as a link, 'User' in monospace, 'Owner', 'Package', 'IP', 'Disk' showing used of quota right aligned, 'Contact', 'Created' and 'Status'. Every row ends in a '...' menu listing 'Modify', 'Suspend', 'Log in as', 'phpMyAdmin', 'Reset 2FA', 'Change password', 'Upgrade/Downgrade', 'Bandwidth usage', 'Enhancements' and a red 'Terminate'. Status pills read 'Active' or 'Suspended'. Empty state: 'No accounts yet. Accounts you create appear here.'
```

Sub-screens (3):

- **Suspend account confirmation**

  ```text
  Confirmation dialog over a dimmed page titled 'Suspend acme?' with the message 'The account's login is locked. Websites and mail are disabled until unsuspended.', a plain 'Cancel' button and a red 'Suspend' button.
  ```

- **Reset two-factor authentication confirmation**

  ```text
  Confirmation dialog 'Reset two-factor authentication for acme?' explaining that the authenticator is removed and every session of that login ends, and that the customer can enrol a new authenticator in the account panel, with 'Cancel' and a red 'Reset 2FA' button.
  ```

- **Terminate account confirmation**

  ```text
  Confirmation dialog 'Terminate acme?' warning that this permanently deletes the Linux user, home directory, databases and DNS for the domain and cannot be undone, with a filled input where the username must be typed before the red 'Terminate' button enables, beside 'Cancel'.
  ```

#### List Parked Domains

`/account-information/list-parked-domains` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'List Parked Domains', breadcrumb Home > Account Information > List Parked Domains, favourite star, description 'Every parked (alias) domain on this server, the account it points at and the document root it shares.'. Header actions: a primary 'Park a Domain' button with a plus icon. Body: one full-width card holding a paginated table with a search box 'Search domain, account or owner…' and columns 'Domain' as a link, 'Kind' shown as an informational pill reading 'Parked' or 'Alias', 'Points at', 'Account' in monospace, 'Main domain', 'Owner', 'Document root' in small monospace with an em dash when absent, 'Created' and 'Status'. Each row ends in a '...' menu with 'DNS zone', 'Modify account' and 'Bandwidth'. Status pills read 'Active' or 'Suspended'. Empty state: 'No parked domains yet. Domains aliased onto a site with Park a Domain appear here.'
```

#### List Subdomains

`/account-information/list-subdomains` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'List Subdomains', breadcrumb Home > Account Information > List Subdomains, favourite star, description 'All subdomains across every account, with the main or addon domain each one hangs off and its document root.'. No header action buttons. Body: one full-width card holding a paginated table with a search box 'Search domain, account or owner…' and sortable columns 'Domain' as a link, 'Root domain', 'Account' in monospace, 'Main domain', 'Owner', 'Document root' in small monospace with an em dash when absent, 'Created' and 'Status'. Each row ends in a '...' menu with 'DNS zone', 'Modify account' and 'Bandwidth'. Status pills read 'Active' or 'Suspended'. Empty state: 'No subdomains yet. Subdomains created under any account appear here.'
```

#### List Suspended Accounts

`/account-information/list-suspended-accounts` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'List Suspended Accounts', breadcrumb Home > Account Information > List Suspended Accounts, favourite star, description 'Accounts currently suspended.'. No header action buttons. Body: one full-width card holding a paginated table filtered to suspended accounts, with a search box 'Search user, domain, owner or email…' and sortable columns 'Domain', 'User' in monospace, 'Owner', 'Package', 'IP', 'Disk' showing used of quota right aligned, 'Contact', 'Created' and 'Status' where every pill reads 'Suspended'. Each row ends in a '...' menu listing 'Modify', 'Unsuspend', 'Log in as', 'phpMyAdmin', 'Reset 2FA', 'Change password', 'Upgrade/Downgrade', 'Bandwidth usage', 'Enhancements' and a red 'Terminate'. Empty state: 'No suspended accounts. Accounts you suspend appear here.'
```

Sub-screens (2):

- **Reset two-factor authentication confirmation**

  ```text
  Confirmation dialog 'Reset two-factor authentication for acme?' explaining that the authenticator is removed and every session of that login ends, with 'Cancel' and a red 'Reset 2FA' button.
  ```

- **Terminate account confirmation**

  ```text
  Confirmation dialog 'Terminate acme?' warning that this permanently deletes the Linux user, home directory, databases and DNS and cannot be undone, with a filled input requiring the username to be typed, a 'Cancel' button and a red 'Terminate' button.
  ```

#### Manage Account Enhancements

`/account-information/manage-account-enhancements` · split

```text
Desktop admin panel screen, 1440px. Page header 'Manage Account Enhancements', breadcrumb Home > Account Information > Manage Account Enhancements, favourite star, description 'Enhancements are named bundles of extra limits (more mailboxes, a CDN, priority support…) sold on top of a package. Define them here, then assign any number of them to an account; the merged limits are exposed to the other panel functions.'. Header actions: a primary 'Create enhancement' button with a plus icon. Body: first a card with a searchable table, search box 'Search enhancements…', columns 'Name' with its description in small grey text beneath, 'ID' in monospace, 'Limits' as small key-value chips, 'Accounts' right aligned, 'Status' and 'Created', each row ending in a '...' menu with 'Edit', 'Disable' and a red 'Delete'. Then a card 'Assign to an account' subtitled 'Pick an account, tick the enhancements it is entitled to and save.' with a 'Filter' input and an 'Account' select, then two columns: a list of switches, one per enhancement with its description and limit chips, above 'Save assignments' and 'Reset' buttons, and a right column headed 'Effective extra limits' with a key and value list. Status pills read 'Enabled' or 'Disabled'. Empty state: 'No enhancements yet. Create one and it appears here, ready to assign to accounts.'
```

Sub-screens (3):

- **Create / edit enhancement modal**

  ```text
  Large modal dialog titled 'Create enhancement' with filled inputs 'Name' and 'ID', a 'Description' textarea, an 'Enabled' switch, and a 'Limits' editor table of 'Key', 'Type' (Number, Yes/No, Text), 'Value' and a 'Remove' button per row, an 'Add limit' button, and 'Cancel' and 'Create' buttons.
  ```

- **Delete enhancement confirmation**

  ```text
  Confirmation dialog 'Delete "Extra Mailboxes (50)"?' explaining that the enhancement is removed from the assigned accounts and that package limits are not affected, with 'Cancel' and a red 'Delete' button.
  ```

- **Empty assign state**

  ```text
  Alternate state of the 'Assign to an account' card after picking an account with no enhancements defined: a centred empty block titled 'No enhancements to assign' reading 'Create an enhancement first.' in place of the switch list.
  ```

#### Show Accounts Over Quota

`/account-information/show-accounts-over-quota` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Show Accounts Over Quota', breadcrumb Home > Account Information > Show Accounts Over Quota, favourite star, description 'Accounts whose measured disk usage has reached their quota. Figures come from repquota when disk quotas are enabled, otherwise from a scheduled du scan of each home directory (every 6 hours).'. Header actions: a 'Refresh disk usage' button with a refresh icon. Body: a row of four stat tiles 'Over quota', 'Usage source', 'Warn threshold' and 'Last measured', each with a small hint line; then an information banner 'Disk quotas are not enforced on this server'; then a card with a segmented control 'Over quota' / 'Near quota' / 'All accounts', search box 'Search account, domain or owner…' and a table of 'Account', 'Domain', 'Owner', 'Package', 'Used', 'Quota', 'Usage' as a percentage bar, 'Status' and 'Measured', rows ending in a '...' menu with 'Change quota', 'Modify account' and a red 'Suspend'. Status pills read 'Over quota', 'Near quota', 'Suspended' or 'OK'. Last a card 'System quota report' with a 'Load report' button and the note 'Requires the quota package. Loads on demand because repquota walks the whole filesystem.'
```

Sub-screens (3):

- **Suspend over-quota account confirmation**

  ```text
  Confirmation dialog 'Suspend acme?' stating how much of its quota the account is using and that suspending locks the login and disables its sites and mail, with 'Cancel' and a red 'Suspend' button.
  ```

- **System quota report loaded**

  ```text
  Alternate state of the 'System quota report' card once loaded: a 'Reload' button, a key and value list of 'Filesystem' and 'Users reported', and a dense table of 'User', 'Domain', 'Used', 'Soft', 'Hard' and 'State' with 'Over' or 'OK' pills.
  ```

- **Disk usage refresh progress**

  ```text
  Drill-down card titled 'Disk usage refresh' subtitled 'Also visible in Task Queue Monitor', holding a scrolling job progress log with a percentage bar while every account's disk usage is measured.
  ```

#### View Bandwidth Usage

`/account-information/view-bandwidth-usage` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'View Bandwidth Usage', breadcrumb Home > Account Information > View Bandwidth Usage, favourite star, description 'Monthly transfer per account, parsed hourly from each site's access logs in the panel's domlog directory. Whether accounts that pass their limit are suspended is decided under Account Functions, Limit Bandwidth Usage.'. Header actions: a 'Collect now' button with an activity icon. Body: four stat tiles 'Total in Nov 2026', 'Over limit (this page)', 'Warn threshold' and 'Last collection' with hint lines; then a card whose toolbar holds a segmented control 'All accounts' / 'Near limit' / 'Over limit', a month select and a search box 'Search account, domain or owner…', over a table of 'Account', 'Domain', 'Owner', 'Transferred', 'Limit', 'Usage' as a percentage bar and 'Status', rows ending in a '...' menu with 'History', 'Change limit' and a red 'Reset this month'. Status pills read 'Suspended', 'Over limit', 'Near limit' or 'OK'. Last a card 'Bandwidth collection' with an 'Automatic suspension on' pill, a 'Limit Bandwidth Usage' button and the fields 'Warn at (% of limit)', 'Max bytes read per log file per run' and 'Extra log directories' above 'Save' and 'Reset'.
```

Sub-screens (4):

- **Bandwidth history drill-down**

  ```text
  Drill-down card 'Bandwidth history: acme' subtitled 'Last 12 months' with 'Clear history' and 'Close' buttons, a monthly transfer bar chart with a limit line, a key and value list of 'Domain', 'Owner', 'Monthly limit' and 'Status', a 'Month' / 'Transferred' / 'Of limit' table and a collapsed 'Log files parsed' section.
  ```

- **Reset this month confirmation**

  ```text
  Confirmation dialog 'Reset this month's counter for acme?' saying the month's total goes back to zero and the account can be unsuspended afterwards if it was suspended for exceeding its limit, with 'Cancel' and a red 'Reset' button.
  ```

- **Clear bandwidth history confirmation**

  ```text
  Confirmation dialog 'Clear all bandwidth history for acme?' saying every recorded month is deleted and that access logs are not touched but already-parsed bytes are not re-read, with 'Cancel' and a red 'Reset' button.
  ```

- **Bandwidth collection job progress**

  ```text
  Drill-down card titled 'Bandwidth collection' subtitled 'Also visible in Task Queue Monitor', holding a scrolling job progress log with a percentage bar while the access logs are parsed.
  ```

### 14. Account Functions

20 screens. Sidebar tile colour for this category is used on its tool cards.

#### Change Site's IP Address

`/account-functions/change-sites-ip-address` · form

```text
Desktop admin panel screen, 1440px. Page header 'Change Site's IP Address', breadcrumb Home > Account Functions > Change Site's IP Address, favourite star, description 'Moves an account's websites to another IP address configured on this server: the account record, its Apache vhosts and the A records of its zones that pointed at the old address.'. No header action buttons. Body: a card 'Select an account' with a 'Filter' input placeholdered 'Type to filter by user, domain or owner' and an 'Account' select; then a card headed with the chosen domain and username holding a key and value list of 'Current IP' in monospace, 'Owner' and 'Domains', and a 'New IP address' select helped by 'Addresses come from IP Functions; a free address becomes dedicated to this account', above a primary 'Change IP address' button.
```

Sub-screens (2):

- **Change IP confirmation**

  ```text
  Confirmation dialog 'Move example.com to 203.0.113.10?' saying the virtual hosts are rewritten and every A record that pointed at the old address is changed in the DNS zone, and that visitors follow once DNS caches expire, with 'Cancel' and a 'Change IP' button.
  ```

- **Result card**

  ```text
  Card titled 'Result' appearing below the form with a key and value list of 'Previous address', 'New address', 'Dedicated' and 'Web server' carrying an 'applied' or 'pending' pill, followed by a list of each changed DNS record with its own pill and a grey explanation.
  ```

#### Create a New Account

`/account-functions/create-a-new-account` · form

```text
Desktop admin panel screen, 1440px. Page header 'Create a New Account', breadcrumb Home > Account Functions > Create a New Account, favourite star, description 'Provision a hosting account.'. No header action buttons. Body: a card 'Domain information' with a two column grid of filled inputs 'Domain' placeholdered example.com, 'Username' helped by 'Lowercase letters, digits, _ or -; starts with a letter; max 32', a masked 'Password' helped by 'Leave blank to set one later via Password Modification' and 'Contact email'. Then a card 'Package' with a 'Package' select placeholdered 'Server default package', a 'Dedicated IP address' input and an 'Owner' input. Then a card 'Provisioning' subtitled about steps staying pending while a daemon is missing, holding three switches with descriptions: 'Web server virtual host', 'DNS zone' and 'Local mail routing'. A sticky bar at the bottom carries a primary 'Create' button.
```

Sub-screens (1):

- **Account created result**

  ```text
  Alternate state replacing the form: a card 'Account created' with a 'Create another' button, a key and value list of 'Domain', 'Username', 'Package', 'IP address', 'Home directory', 'Linux user', 'Web vhost', 'DNS zone', 'Mail routing' and 'Databases' each with a status pill, a grey note about pending steps, and a 'Go to List Accounts' button.
  ```

#### Email All Users

`/account-functions/email-all-users` · form

```text
Desktop admin panel screen, 1440px. Page header 'Email All Users', breadcrumb Home > Account Functions > Email All Users, favourite star, description 'Sends a plain-text message to the contact address of every account you manage. Placeholders for username, domain and hostname are replaced per recipient. Delivery goes through this server's Exim.'. No header action buttons. Body: a card 'Recipients' with a 'Which accounts' select offering 'All accounts', 'Active accounts only' and 'Suspended accounts only', an 'Owned by' input helped by 'Limit to one reseller's accounts (blank = everyone)', a 'From address' input helped by 'Blank uses the server's notification sender', and a grey line counting recipients and accounts skipped for having no contact email. Then a card 'Message' with a 'Subject' input, a tall 'Body' textarea and a primary 'Send to 12 recipients' button.
```

Sub-screens (2):

- **Send confirmation**

  ```text
  Confirmation dialog 'Email 12 account owner(s)?' quoting the subject line and saying it is handed to the mail server for every account with a contact address in the selection, with a 'Cancel' button and a 'Send' button.
  ```

- **Delivery progress**

  ```text
  Card titled 'Delivery' appearing below the form with a scrolling job progress log and a percentage bar, followed once finished by a key and value list of 'Sent', 'Failed' and 'Failures' naming each account and its error.
  ```

#### Force Password Change

`/account-functions/force-password-change` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Force Password Change', breadcrumb Home > Account Functions > Force Password Change, favourite star, description 'Flags accounts so their owner must set a new password at the next panel login. The flag clears automatically when the password is changed (Password Modification).'. No header action buttons. Body: a row of three stat tiles 'Accounts', 'Change required' and 'Selected'; then a card holding a table with row checkboxes, a filter box 'Filter by user, domain or owner', columns 'User' in monospace, 'Domain', 'Owner', 'Status' and 'Change required' with 'On' or 'Off' pills, and a '...' menu per row reading 'Require change' or 'Clear requirement'. The table toolbar carries 'Require change (3)', 'Clear requirement (3)' and 'Require change for all accounts'. Empty state: 'No accounts yet. Accounts you create appear here.'
```

Sub-screens (1):

- **Last change summary**

  ```text
  Card titled 'Last change' appearing under the table, with one sentence naming the action, the number of accounts changed and the usernames, how many were already in that state, and any that were not found or not yours.
  ```

#### Limit Bandwidth Usage

`/account-functions/limit-bandwidth-usage` · form

```text
Desktop admin panel screen, 1440px. Page header 'Limit Bandwidth Usage', breadcrumb Home > Account Functions > Limit Bandwidth Usage, favourite star, description 'Caps the monthly transfer of an account. Usage is counted from the web logs; with enforcement on, an account over its cap is suspended with a bandwidth reason until the counters reset on the 1st or an administrator unsuspends it.'. No header action buttons. Body: a card 'Select an account' with a 'Filter' input and an 'Account' select; then a card headed with the domain and username holding a key and value list of 'Used this month', 'Current limit', 'Package default' and 'Status', an 'Unlimited bandwidth' switch described as 'No monthly cap; usage is still counted', a 'Monthly limit (MB)' number input helped by '1024 MB = 1 GB', and a primary 'Save limit' button. Then a card 'Enforcement' with a switch 'Suspend accounts that exceed their limit'. Last a card 'All accounts' holding a dense table of 'User', 'Domain', 'Used', 'Limit' and 'Usage' as a percentage pill, each row offering 'Edit'.
```

#### Manage Account Suspension

`/account-functions/manage-account-suspension` · action

```text
Desktop admin panel screen, 1440px. Page header 'Manage Account Suspension', breadcrumb Home > Account Functions > Manage Account Suspension, favourite star, description 'Suspend or unsuspend with a reason.'. No header action buttons. Body: a card 'Select an account' with a 'Filter' input placeholdered 'Type to filter by user, domain or owner' and an 'Account' select; then a card headed with the chosen domain and username holding a key and value list of 'Status' with an 'Active' or 'Suspended' pill plus 'Reason' and 'Suspended at' when suspended, a grey paragraph explaining that suspending locks the Linux user so SSH, FTP and mailbox logins stop working while the websites keep their content until the web server integration switches them, then a 'Reason (shown to the account owner)' textarea placeholdered 'e.g. Non-payment, abuse report #123' and a red 'Suspend account' button.
```

Sub-screens (2):

- **Suspend confirmation**

  ```text
  Confirmation dialog 'Suspend acme?' explaining that the Linux account is locked, blocking SSH, FTP and mailbox logins, and that the sites switch to the suspended page only when the web server integration provides it, with 'Cancel' and a red 'Suspend' button.
  ```

- **Suspended account state**

  ```text
  Alternate state of the account card when the account is already suspended: the status pill reads 'Suspended' with its reason and suspension date in the key and value list, the reason textarea is gone, and a single primary 'Unsuspend account' button sits at the bottom.
  ```

#### Manage Demo Mode

`/account-functions/manage-demo-mode` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Demo Mode', breadcrumb Home > Account Functions > Manage Demo Mode, favourite star, description 'Demo accounts are read-only: their panel login can browse every feature but no change is applied to the server. Useful for showcasing the control panel.'. No header action buttons. Body: a row of three stat tiles 'Accounts', 'Demo mode' and 'Selected'; then a card holding a table with row checkboxes, a filter box 'Filter by user, domain or owner', columns 'User' in monospace, 'Domain', 'Owner', 'Status' with 'Active' or 'Suspended' pills and 'Demo mode' with 'On' or 'Off' pills, and a '...' menu per row reading 'Enable demo mode' or 'Disable demo mode'. The toolbar carries 'Enable demo mode (3)', 'Disable demo mode (3)' and 'Enable demo mode for all accounts'. Empty state: 'No accounts yet. Accounts you create appear here.'
```

Sub-screens (2):

- **Enable demo mode confirmation**

  ```text
  Confirmation dialog 'Enable demo mode for 3 account(s)?' with the message 'Owners of these accounts will be able to log in but not change anything until demo mode is disabled.', a 'Cancel' button and an 'Enable demo mode' button.
  ```

- **Last change summary**

  ```text
  Card titled 'Last change' appearing under the table, with one sentence naming the action, the number of accounts changed and their usernames, how many were already in that state, and any that were not found or not yours.
  ```

#### Manage Shell Access

`/account-functions/manage-shell-access` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Shell Access', breadcrumb Home > Account Functions > Manage Shell Access, favourite star, description 'Controls SSH access per account: no shell, a jailed shell limited to the account's files, or a normal shell. Applied to the Linux user immediately.'. No header action buttons. Body: a card 'Shell to apply' holding a radio group of four options each with a description: 'Disabled' (no SSH login, FTP and the panel still work), 'Jailed shell' (SSH confined to the account's own files, must be installed), 'Normal shell' (full bash login) and 'POSIX shell'. Then a card holding a table with row checkboxes, a filter box 'Filter by user, domain or owner', columns 'User' in monospace, 'Domain', 'Owner', 'Current shell' as a pill beside the shell path, and 'Linux user' as a pill reading a UID or 'not provisioned'. Each row offers 'Set Disabled'; the toolbar carries a primary 'Apply to selected (3)'. Empty state: 'No accounts yet. Accounts created with Create a New Account appear here.'
```

Sub-screens (1):

- **Apply shell confirmation**

  ```text
  Confirmation dialog 'Give 3 account(s) a normal shell?' explaining that the Linux login shell is changed with usermod and that the owner can then log in over SSH with the account password or keys, with 'Cancel' and an 'Apply' button.
  ```

#### Modify an Account

`/account-functions/modify-an-account` · form

```text
Desktop admin panel screen, 1440px. Page header 'Modify an Account', breadcrumb Home > Account Functions > Modify an Account, favourite star, description 'Change domain, owner, package and limits.'. No header action buttons. Body: a card 'Select an account' with a 'Filter' input and an 'Account' select; then a card headed with the domain and username, subtitled with the owner and creation date, holding a key and value list of 'Status', 'Home', 'Disk used' and 'Bandwidth used'. Then a card 'Basic information' with 'Contact email', a 'Package' select helped by 'Changing the package re-applies its limits', 'IP address' placeholdered 'Shared IP' and 'Owner'. Then a card 'Resource limits' with 'Disk quota (MB)', 'Monthly bandwidth limit (MB)' both helped by 'Blank = unlimited', and a 'Shell access' select. Then a card 'Privileges' with switches 'Demo mode' and 'Force password change'. A sticky bar carries a primary 'Save' button.
```

#### Password Modification

`/account-functions/password-modification` · form

```text
Desktop admin panel screen, 1440px. Page header 'Password Modification', breadcrumb Home > Account Functions > Password Modification, favourite star, description 'Set an account's password.'. No header action buttons. Body: a card 'Select an account' holding a 'Filter' input placeholdered 'Type to filter by user, domain or owner' and an 'Account' select whose help line counts the accounts. Then a narrow card titled 'New password for acme' subtitled 'Changes the Linux user password used for SSH/FTP and the account's panel login.', holding a single required masked 'New password' field with a reveal control and a strength meter, and a primary 'Change password' button. An inline error banner above the field reads 'Choose a stronger password (minimum strength 65)' when the password is too weak.
```

#### Quota Modification

`/account-functions/quota-modification` · form

```text
Desktop admin panel screen, 1440px. Page header 'Quota Modification', breadcrumb Home > Account Functions > Quota Modification, favourite star, description 'Changes an account's disk quota. The soft limit is the quota; the hard limit is 5% above it. Applied with setquota on the filesystem that holds the home directory.'. No header action buttons. Body: a card 'Select an account' with a 'Filter' input and an 'Account' select; then a card headed with the domain and username holding a key and value list of 'Used', 'Current quota', 'Live limits (repquota)', 'Package default' and 'Home', an 'Unlimited disk space' switch described as 'No quota on the filesystem; usage is still measured', a 'Disk quota (MB)' number input helped by '1024 MB = 1 GB', and a primary 'Save quota' button. Last a card 'Quota report' subtitled 'Live usage from repquota next to the panel's record' with a 'Refresh' button and a dense table of 'User', 'Domain', 'Filesystem', 'Used', 'Quota' and 'Live' pills, each row offering 'Edit'.
```

#### Raw Apache Log Download

`/account-functions/raw-apache-log-download` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'Raw Apache Log Download', breadcrumb Home > Account Functions > Raw Apache Log Download, favourite star, description 'Downloads the raw per-domain access and error logs Apache writes for an account, plus the PHP error log in the account's logs directory. Rotated files are included.'. No header action buttons. Body: a card 'Select an account' with a 'Filter' input placeholdered 'Type to filter by user, domain or owner' and an 'Account' select. Then a card titled 'Apache logs for acme', subtitled with the directories that were searched and carrying a 'Refresh' button, holding a dense table with columns 'File' in monospace, 'Directory' in monospace, 'Size' right aligned, 'Last written' and an unlabelled last column holding a 'Download' link per row.
```

Sub-screens (1):

- **No log files empty state**

  ```text
  Alternate state of the logs card: a centred empty block titled 'No log files yet' reading 'Apache creates the access and error logs once the site has served its first request.', with the 'Refresh' button still in the card header.
  ```

#### Raw NGINX Log Download

`/account-functions/raw-nginx-log-download` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'Raw NGINX Log Download', breadcrumb Home > Account Functions > Raw NGINX Log Download, favourite star, description 'Downloads the raw NGINX logs that mention one of the account's domains and any nginx log in the account's logs directory. Requires NGINX on this server.'. No header action buttons. Body: a card 'Select an account' with a 'Filter' input placeholdered 'Type to filter by user, domain or owner' and an 'Account' select. Then a card titled 'NGINX logs for acme', subtitled with the directories that were searched and carrying a 'Refresh' button, holding a dense table with columns 'File' in monospace, 'Directory' in monospace, 'Size' right aligned, 'Last written' and an unlabelled last column holding a 'Download' link per row. A capability notice replaces the table when NGINX is not installed.
```

Sub-screens (1):

- **No log files empty state**

  ```text
  Alternate state of the logs card: a centred empty block titled 'No log files yet' reading 'NGINX writes per-domain logs once a vhost for this account has served traffic.', with the 'Refresh' button still in the card header.
  ```

#### Rearrange an Account

`/account-functions/rearrange-an-account` · progress-log

```text
Desktop admin panel screen, 1440px. Page header 'Rearrange an Account', breadcrumb Home > Account Functions > Rearrange an Account, favourite star, description 'Moves an account's home directory to another partition when a disk fills up. Runs as a job with the account suspended: rsync copy, a second sync for files changed meanwhile, the Linux home change, vhost rewrite, removal of the old tree once both succeeded, then the account is unsuspended.'. No header action buttons. Body: a card 'Home partitions' with a 'Refresh' button over a dense table of 'Directory' in monospace, 'Present' as a yes or missing pill, 'Filesystem', 'Free' right aligned, 'Used' as a percentage and 'Accounts'. Then a card 'Select an account' with a 'Filter' input and an 'Account' select. Then a card headed with the domain and username holding a key and value list of 'Current home', 'Partition' and 'Linux user', a 'Move to' select helped by 'Only partitions that exist on this server are offered', and a red 'Move account' button.
```

Sub-screens (4):

- **Move account confirmation**

  ```text
  Confirmation dialog 'Move acme to /home2?' explaining the account is suspended for the duration, the home directory is copied with rsync, the Linux user and web server are pointed at it, and the old directory is deleted only once both switched, with a type-the-username input, 'Cancel' and a red 'Move account' button.
  ```

- **Move progress**

  ```text
  Card titled 'Move progress' appearing below the form, holding a scrolling job log of the rsync copy, second sync, home change, vhost rewrite, old tree removal and unsuspend steps, with a percentage bar and the current step highlighted.
  ```

- **Old home kept warning**

  ```text
  Warning banner inside the 'Move progress' card reading that the old home was kept, that the account now lives in the new directory but the web server could not be pointed at it, and that the sites should be verified before removing the old directory by hand.
  ```

- **Move failed and rolled back**

  ```text
  Error banner inside the 'Move progress' card reading 'The move failed and was rolled back' with the error text, and the note that the account keeps its previous home directory and was unsuspended.
  ```

#### Reset Account Bandwidth Limit

`/account-functions/reset-account-bandwidth-limit` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Reset Account Bandwidth Limit', breadcrumb Home > Account Functions > Reset Account Bandwidth Limit, favourite star, description 'Clears the current month's bandwidth counter of selected accounts. The scheduler does this for every account on the 1st of each month.'. No header action buttons. Body: one full-width card holding a table with row checkboxes and columns 'User' in monospace, 'Domain', 'Owner', 'Used' right aligned, 'Limit' right aligned and 'Status' as a pill reading 'Suspended (bandwidth)', 'Over limit' or 'Active'. Each row offers a 'Reset' action. The toolbar carries an 'Unsuspend bandwidth-suspended accounts' switch, a primary 'Reset selected (3)' button and a 'Reset all' button. Empty state: 'No accounts yet. Accounts you create appear here.'
```

Sub-screens (2):

- **Reset counters confirmation**

  ```text
  Confirmation dialog 'Reset bandwidth counters for 3 account(s)?' saying the current month's transfer counter is zeroed and that accounts suspended for exceeding their bandwidth are unsuspended when the option is on, with 'Cancel' and a 'Reset' button.
  ```

- **Last reset summary**

  ```text
  Card titled 'Last reset' appearing under the table, with one sentence naming the period in monospace, how many accounts were reset, which were unsuspended and which were not found.
  ```

#### Terminate Accounts

`/account-functions/terminate-accounts` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Terminate Accounts', breadcrumb Home > Account Functions > Terminate Accounts, favourite star, description 'Permanently remove accounts.'. No header action buttons. Body: one full-width card holding a paginated table with row checkboxes, a search box, and sortable columns 'User' in monospace, 'Domain', 'Owner', 'Package', 'Disk used' right aligned and 'Status' with 'Active' or 'Suspended' pills. Each row ends in a '...' menu whose single red item is 'Terminate'. The table toolbar carries a 'Keep DNS zones' switch and a red 'Terminate selected (3)' button that is disabled until rows are ticked.
```

Sub-screens (1):

- **Terminate confirmation**

  ```text
  Confirmation dialog 'Terminate 3 accounts?' warning that this permanently removes the Linux users, home directories, databases, mail and DNS zones and cannot be undone, with a filled input where TERMINATE must be typed, a 'Cancel' button and a red 'Terminate' button.
  ```

#### Unsuspend Bandwidth Exceeders

`/account-functions/unsuspend-bandwidth-exceeders` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Unsuspend Bandwidth Exceeders', breadcrumb Home > Account Functions > Unsuspend Bandwidth Exceeders, favourite star, description 'Accounts that are over their monthly bandwidth limit, or were suspended for exceeding it. Unsuspending lifts the lock; resetting the counter keeps the enforcement job from suspending them again this month.'. Header actions: a 'Refresh' button. Body: one full-width card holding a table with row checkboxes and columns 'User' in monospace, 'Domain', 'Owner', 'Used' right aligned, 'Limit' right aligned and 'Status' as a pill reading 'Suspended for bandwidth' or 'Over limit (not suspended)'. Suspended rows offer an 'Unsuspend' action. The toolbar carries an 'Also reset counters' switch, a primary 'Unsuspend selected (2)' button and an 'Unsuspend all (5)' button.
```

Sub-screens (3):

- **Unsuspend confirmation**

  ```text
  Confirmation dialog 'Unsuspend 2 account(s)?' saying the accounts are unlocked and their bandwidth counters zeroed so they are not suspended again at the next check, with 'Cancel' and an 'Unsuspend' button.
  ```

- **No exceeders empty state**

  ```text
  Alternate state of the card: a centred empty block titled 'No bandwidth exceeders' reading 'Every account is under its limit and none is suspended for bandwidth.' in place of the table and its toolbar.
  ```

- **Last run summary**

  ```text
  Card titled 'Last run' appearing under the table, listing each account in monospace with a green 'unsuspended' pill, and any failures with a red pill carrying the error text.
  ```

#### Upgrade/Downgrade an Account

`/account-functions/upgrade-downgrade-an-account` · form

```text
Desktop admin panel screen, 1440px. Page header 'Upgrade/Downgrade an Account', breadcrumb Home > Account Functions > Upgrade/Downgrade an Account, favourite star, description 'Change an account's package.'. No header action buttons. Body: a card 'Select an account' holding a 'Filter' input placeholdered 'Type to filter by user, domain or owner' and an 'Account' select. Then a card titled 'Current package: Starter' holding a key and value list of 'Disk', 'Bandwidth', 'Addon domains', 'Databases', 'Email accounts' and 'Shell', then a 'New package' select helped by 'The new package's limits are applied to the account immediately', then the same six-row key and value list again for the chosen package so the two can be compared, and a primary 'Upgrade/Downgrade' button that stays disabled until a package is picked.
```

#### Web Log Retention

`/account-functions/web-log-retention` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Web Log Retention', breadcrumb Home > Account Functions > Web Log Retention, favourite star, description 'Per-account policy for the raw Apache logs: whether a monthly archive is kept in the account's logs archive and for how long. Rotation of the live logs is configured under Service Configuration, Log Rotation Configuration. The archive job runs on the 1st of each month.'. Header actions: a primary 'Archive now (4)' button. Body: a card 'Accounts' subtitled '12 accounts, 4 archiving monthly' holding a dense table of 'User' in monospace, 'Domain', 'Owner', 'Archive' as a pill reading 'monthly' or 'off', 'Keep' showing the months and '(never pruned)' when pruning is off, 'Last archived' and 'Source' reading 'account setting' or 'server default'. Each row ends in a '...' menu with 'Edit' and 'Archive now'. Empty state: 'No accounts yet. Each account appears here with its archive policy.'
```

Sub-screens (2):

- **Edit retention modal**

  ```text
  Modal dialog titled 'Web log retention: acme' with a switch 'Archive logs in the home directory' described with the source and archive paths, a switch 'Remove old archives' described as deleting archives older than the retention period, a 'Keep archives for (months)' number input, and 'Cancel' and 'Save' buttons.
  ```

- **Archive job progress**

  ```text
  Card titled 'Archive job' appearing below the table, holding a scrolling job progress log with a percentage bar while the monthly log archives are written for each account with archiving enabled.
  ```

#### Web Template Editor

`/account-functions/web-template-editor` · config

```text
Desktop admin panel screen, 1440px. Page header 'Web Template Editor', breadcrumb Home > Account Functions > Web Template Editor, favourite star, description 'Edits the HTML page templates kept under the template directory. Today only the default site page is served: it is written into public_html when an account is created. The suspended, moved and 4xx pages are saved and written to the template directory but are not referenced by the web server configuration yet.'. No header action buttons. Body: a card 'Template' with a 'Page' select offering 'Default site page (new accounts)', 'Suspended account page', 'Site moved page' and '4xx error page', then a key and value list of 'File', 'Status' with a 'customised' or 'built-in default' pill, 'Served' with an 'in use' or 'not yet served' pill, 'Last saved' and 'Variables' as monospace placeholders, and a warning banner 'This page is not served yet'. Then a card named after the chosen page with a 'Preview' button, a tall monospace 'HTML' textarea helped by 'A complete HTML document. Variables are HTML-escaped when rendered.', and 'Save', 'Discard changes' and a right-aligned red 'Reset to default'.
```

Sub-screens (3):

- **Reset template confirmation**

  ```text
  Confirmation dialog 'Reset index to the built-in template?' with the message 'Your customised HTML is replaced by the default page.', a 'Cancel' button and a red 'Reset' button.
  ```

- **Preview card**

  ```text
  Card titled 'Preview' subtitled 'Rendered with sample values' appearing at the bottom of the page, holding a bordered, rounded embedded frame about 420 pixels tall that renders the edited HTML with the variables filled in.
  ```

- **Saved in the panel only warning**

  ```text
  Warning banner inside the editor card headed 'Saved in the panel only', with a paragraph giving the write error returned by the server when the template file itself could not be written to disk.
  ```

### 15. Multi Account Functions

2 screens. Sidebar tile colour for this category is used on its tool cards.

#### Change Multiple Sites' IP Addresses

`/multi-account-functions/change-multiple-sites-ip-addresses` · wizard

```text
Desktop admin panel screen, 1440px. Page header 'Change Multiple Sites' IP Addresses', breadcrumb Home > Multi Account Functions > Change Multiple Sites' IP Addresses, favourite star, description 'Moves several accounts to other IPv4 addresses in one run: pick the accounts, choose a new address per account or one for all, review the plan, then the job updates each account record, rewrites its virtual hosts and the A records of its zones.' A three-step indicator 'Select accounts and addresses', 'Review plan', 'Run'. Body: card 'Select accounts' with filters 'Search', 'Owner', 'Package', 'IP address', 'Status' and a checkbox table 'User', 'Domain', 'Owner', 'Package', 'IP', 'Disk', 'Status', 'New IP'; card 'New addresses' with 'Address for every selected account' and switches 'Rewrite virtual hosts', 'Rewrite A records', 'Require installed services', a per-account table 'User', 'Domain', 'Current IP', 'New IP', buttons 'Preview changes' and 'IP address usage'; card 'Recent runs' with 'Run', 'Status', 'Result', 'By', 'Started'.
```

Sub-screens (4):

- **Step 2 of 3 — Plan**

  ```text
  Step 2 of 3, card 'Plan' subtitled 'No blocking problems found', with stat tiles 'Accounts', 'To change', 'Unchanged', 'Blocked', 'A records', 'Virtual hosts', 'Become dedicated', a warning banner 'Before you run', and a table 'User', 'Domain', 'Current', 'New', 'A records', 'Vhosts', 'Status', 'Problems'. Buttons 'Back' and a red 'Change IP addresses now'.
  ```

- **Change IP confirmation**

  ```text
  Destructive confirmation dialog 'Change the IP address of 12 account(s)?' saying how many virtual hosts are rewritten and how many A records are updated and published, that visitors follow once DNS caches expire, and how many accounts are left alone. Buttons 'Cancel' and a red 'Change IP addresses'.
  ```

- **Step 3 of 3 — Run**

  ```text
  Step 3 of 3, card 'Changing IP addresses' with a live progress bar and timestamped job log, then buttons 'Start another run', 'Download CSV report', 'Download JSON report' and 'Refresh', followed by the per-account result card.
  ```

- **Run detail drill-down**

  ```text
  Drill-down card 'Run #41 · IP change' subtitled with who started it and when it finished, stat tiles 'Accounts', 'Applied', 'Pending', 'Failed', 'Unchanged', 'Skipped', and a table 'User', 'Domain', 'Status', 'Change', 'Steps', 'Detail' where each step is a small labelled pill.
  ```

#### Modify/Upgrade Multiple Accounts

`/multi-account-functions/modify-upgrade-multiple-accounts` · wizard

```text
Desktop admin panel screen, 1440px. Page header 'Modify/Upgrade Multiple Accounts', breadcrumb Home > Multi Account Functions > Modify/Upgrade Multiple Accounts, favourite star, description 'Applies the same changes to many accounts in one run: move them to another package, set disk or bandwidth limits, shell, contact address, demo mode, forced password change or owner. Review the per-account differences first; every account is modified on its own and reported separately.' A three-step indicator 'Select accounts and changes', 'Review differences', 'Run'. Body: card 'Select accounts' with filters 'Search', 'Owner', 'Package', 'IP address', 'Status' and a checkbox table 'User', 'Domain', 'Owner', 'Package', 'IP', 'Disk', 'Status'; card 'Changes to apply' subtitled 'Tick a field to include it', with switches that reveal a control for 'Package', 'Disk quota (MB)', 'Bandwidth limit (MB)', 'Shell', 'Contact email', 'Demo mode', 'Force password change', 'Owner', plus 'Apply the package's PHP version to the virtual hosts' and 'Require installed services', and a 'Preview differences' button; card 'Recent runs'.
```

Sub-screens (4):

- **Step 2 of 3 — Differences**

  ```text
  Step 2 of 3, card 'Differences' subtitled 'No blocking problems found', with stat tiles 'Accounts', 'To change', 'Unchanged', 'Blocked', 'Fields', a warning banner 'Before you run', and a table 'User', 'Domain', 'Owner', 'Status', 'Changes' where each change reads as old value arrow new value. Buttons 'Back' and a red 'Modify accounts now'.
  ```

- **Modify accounts confirmation**

  ```text
  Destructive confirmation dialog 'Modify 8 account(s)?' summarising each chosen field and its new value, noting that limits are applied to the Linux user and, for a package with a PHP version, to the virtual hosts, and how many accounts already have these values. Buttons 'Cancel' and a red 'Modify accounts'.
  ```

- **Step 3 of 3 — Run**

  ```text
  Step 3 of 3, card 'Modifying accounts' with a live progress bar and timestamped job log, then buttons 'Start another run', 'Download CSV report', 'Download JSON report' and 'Refresh', followed by the per-account outcome card.
  ```

- **Run detail drill-down**

  ```text
  Drill-down card 'Run #17 · modify/upgrade' subtitled with who started it and when, stat tiles 'Accounts', 'Applied', 'Pending', 'Failed', 'Unchanged', 'Skipped', and a table 'User', 'Domain', 'Status', 'Change', 'Steps', 'Detail' listing each field change and each step pill.
  ```

### 16. Transfers

4 screens. Sidebar tile colour for this category is used on its tool cards.

#### Convert Addon Domain to Account

`/transfers/convert-addon-domain-to-account` · form

```text
Desktop admin panel screen, 1440px. Page header 'Convert Addon Domain to Account', breadcrumb Home > Transfers > Convert Addon Domain to Account, favourite star, description 'Turns an addon domain into a standalone account: a new account is created with the addon domain as its main domain, the document root is copied into its public_html, mailboxes for the domain move along, the DNS zone changes owner and both accounts' virtual hosts are rewritten.' Body: a warning banner about missing tools with an install button; card 'Addon domains' with a 'Refresh' action and table 'Addon domain', 'Account', 'Main domain', 'Document root', 'Package', 'Added' and a row 'Convert' action; card 'New account for <domain>' with fields 'New username', 'Password', 'Package', 'Contact email' and switches 'Copy the document root', 'Delete the files from the old account afterwards', 'Move mailboxes of the domain', plus buttons 'Check' and 'Convert to account'; card 'Recent runs' with 'Run', 'Kind', 'Source', 'Status', 'Result', 'By', 'Started'.
```

Sub-screens (4):

- **Plan card**

  ```text
  Drill-down card 'Plan' shown after Check: a red 'Cannot convert' banner listing blocking issues, a yellow 'Before you run' warning list, and a key/value block 'From', 'To', 'Linked subdomains', 'DNS zone' with an existing or new pill, and 'Databases'.
  ```

- **Move databases picker**

  ```text
  Alternate state inside the new-account card, root only: a field 'Move databases to the new account' helped by a note that moved databases are reassigned not copied, holding one switch per database name of the source account.
  ```

- **Convert confirmation**

  ```text
  Confirmation dialog 'Convert shop.example.com into the account shopex?' saying the domain leaves its current account together with any linked subdomains, that the document root files are copied and then deleted from the old one, and that the DNS zone and mail routing move with the domain, with a text box to type the domain. Buttons 'Cancel' and a red 'Convert'.
  ```

- **Run panel**

  ```text
  Progress view replacing the form: card 'Converting shop.example.com' with a live progress bar and timestamped job log, buttons 'Convert another addon domain', 'Refresh' and 'Review all runs', followed by the per-account run detail card with its steps.
  ```

#### Review Transfers and Restores

`/transfers/review-transfers-and-restores` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Review Transfers and Restores', breadcrumb Home > Transfers > Review Transfers and Restores, favourite star, description 'Every transfer, cpmove restore and addon conversion with its per-account outcome, the steps that are still pending (for example zones waiting for BIND) and the full job log.' No header actions. Body: a two-option segmented control 'Runs' and 'Job log'. On 'Runs': stat tiles 'Runs', 'Accounts', 'Done', 'Pending', 'Failed', then card 'Transfers and restores' with a refresh action, a kind dropdown listing 'Transfer', 'Restore', 'Addon conversion', and a table 'Run', 'Kind', 'Source', 'Status', 'Accounts', 'By', 'Started', 'Finished' with a row action 'Details and log'. Status pills for done, pending, failed. Empty state 'No transfers or restores have run yet. Runs started from the Transfer Tool, Transfer or Restore an Account and Convert Addon Domain to Account appear here.'
```

Sub-screens (3):

- **Job log tab**

  ```text
  Alternate tab of the same page: card 'Job queue entries' subtitled 'Every transfer.* and restore.* job, including restores started from other tools.', a status dropdown with 'queued', 'running', 'done', 'failed', 'cancelled', and a table 'Job', 'Type', 'Status', 'Progress', 'Run', 'By', 'Queued', 'Finished', 'Error' with a row action 'Log'.
  ```

- **Run details drill-down**

  ```text
  Drill-down card 'Run #23 · Transfer' subtitled with its source, who started it and when it finished, stat tiles 'Accounts', 'Done', 'Pending', 'Failed', 'Skipped', a table 'Source', 'Account', 'Domain', 'Status', 'Steps', 'Detail' with per-step pills, and a 'Job log' block of monospaced timestamped lines.
  ```

- **Job log drill-down**

  ```text
  Drill-down card 'Job #88 · transfer.run' subtitled with its status and queue and finish times, showing either a live progress bar with streaming log for a queued or running job, or a monospaced block of timestamped level-tagged log lines followed by the job's result as formatted JSON.
  ```

#### Transfer or Restore an Account

`/transfers/transfer-or-restore-a-cpanel-account` · wizard

```text
Desktop admin panel screen, 1440px. Page header 'Transfer or Restore an Account', breadcrumb Home > Transfers > Transfer or Restore an Account, favourite star, description 'Imports one account from a cPanel account archive: the account is created, the home directory extracted, databases and grants imported, and zones, addon and parked domains recreated.', with a muted line under it linking to the Transfer Tool for migrating from a running server. A three-step indicator 'Choose archive', 'Options', 'Restore'. Body: a warning banner about missing tools with an install button; card 'Upload an archive' subtitled that archives are uploaded in chunks and resumed after a dropped connection, with a 'Choose an archive' button; card 'Archives on this server' with a refresh action and table 'Archive', 'Directory', 'Size', 'Modified' with a row 'Inspect' action, and below it a field 'Or enter the path of an archive' with an 'Inspect' button; card 'Recent runs'.
```

Sub-screens (5):

- **Upload progress state**

  ```text
  State inside 'Upload an archive': a progress bar with a percentage, bytes sent of total, the file name, and a muted note reading 'resumed' or 'rate limited, waiting 8 s' while the chunked upload retries. The 'Choose an archive' button shows a loading spinner and is disabled.
  ```

- **Step 2 of 3 — Options**

  ```text
  Step 2 of 3: card 'Archive: cpmove-alice' subtitled with its path, size and date, a 'Choose another archive' action, and a key/value list 'Account in archive', 'Main domain', 'Package on source', 'Contact', 'Home directory', 'Password', 'Databases', 'Database users', 'DNS zones', 'Extra domains' with exists, taken and new pills.
  ```

- **Step 2 of 3 — Restore as form**

  ```text
  Second card of step 2, 'Restore as', with fields 'Username', 'Main domain', 'Package' and 'New password', then switches 'Skip the home directory', 'Skip databases', 'Skip DNS zones', 'Restore into an existing account'. One primary button 'Restore account'.
  ```

- **Restore confirmation**

  ```text
  Confirmation dialog 'Restore cpmove-alice as alice?' saying the domain is created as the main domain, the home directory is extracted and how many databases are imported. Buttons 'Cancel' and 'Restore account'.
  ```

- **Step 3 of 3 — Restore**

  ```text
  Step 3 of 3, card 'Restoring alice' with a live progress bar and timestamped job log, buttons 'Restore another archive', 'Refresh' and 'Review all runs', followed by the run detail card with per-account steps and the job log.
  ```

#### Transfer Tool

`/transfers/transfer-tool` · wizard

```text
Desktop admin panel screen, 1440px. Page header 'Transfer Tool', breadcrumb Home > Transfers > Transfer Tool, favourite star, description 'Moves accounts from another server over SSH: the Linux account is created here, the home directory is copied with rsync, MySQL databases are dumped on the source and imported, and DNS zones, addon domains and mail routing are recreated. Each run is a job you can watch and review.' A three-step indicator 'Connect', 'Choose accounts and options', 'Transfer'. Body: a warning banner about missing tools with install buttons; card 'Connect to the source server' subtitled that credentials are tested over SSH and kept encrypted, with fields 'Remote server', 'SSH port', 'SSH user', an 'Authentication' radio group of 'Private key' and 'Password', a 'Private key' text area, and the button 'Connect and list accounts'; card 'Open connections' with a table 'Server', 'Detected', 'Host key', 'Auth', 'Expires' and row actions 'Use' and 'Forget'; card 'Recent runs'.
```

Sub-screens (6):

- **Forget connection confirmation**

  ```text
  Destructive confirmation dialog 'Forget root@old-server.example.com?' saying the stored credential is deleted and running transfers keep working. Buttons 'Cancel' and a red 'Forget'.
  ```

- **Step 2 of 3 — Source summary**

  ```text
  Step 2 of 3: card 'Source: root@old-server.example.com' with actions 'Change server' and 'Re-scan accounts', holding a key/value list 'System', 'Control panel', 'SSH user', 'Host key' with fingerprints, 'Source tools' with yes and missing pills, 'Source /home' and 'Account list'.
  ```

- **Step 2 of 3 — Select accounts**

  ```text
  Card 'Select accounts' subtitled with the selected count and a note that passwords are copied from the source unless a new one is entered. Checkbox table 'Source user', 'Main domain', 'Other domains', 'Home', 'Here', 'Local username', 'Domain', 'Package', 'Password' with inline inputs per row, toolbar buttons 'Select all new' and 'Clear'.
  ```

- **Step 2 of 3 — Options and plan**

  ```text
  Card 'Options' with switches 'Skip home directories', 'Skip databases', 'Skip DNS zones', 'Overwrite existing accounts' and buttons 'Check plan' and 'Start transfer'; then card 'Plan' with stat tiles 'Accounts', 'Ready', 'Blocked', a 'Before you run' warning banner, and a table 'Source', 'Local account', 'Domain', 'Package', 'Status'.
  ```

- **Start transfer confirmation**

  ```text
  Confirmation dialog 'Transfer 5 account(s) from old-server.example.com?' saying accounts are created here, home directories copied with rsync, databases dumped and imported and zones imported, and that sites on the source keep running. Buttons 'Cancel' and 'Start transfer'.
  ```

- **Step 3 of 3 — Transfer**

  ```text
  Step 3 of 3, card 'Transferring from old-server.example.com' with a live progress bar and timestamped job log, buttons 'Transfer more accounts', 'Refresh' and 'Review all runs', then the run detail card with per-account steps, sizes and any unstored source zone text in a collapsible block.
  ```

### 17. Themes

1 screens. Sidebar tile colour for this category is used on its tool cards.

#### Theme Manager

`/themes/theme-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Theme Manager', breadcrumb Home > Themes > Theme Manager, favourite star, description 'Default interface themes and branding.'. Header actions: 'New theme'. Under the header a segmented control 'Themes', 'Defaults', 'Package assignment', 'My preference' with 'Themes' selected. Body: card 'Installed themes', subtitle 'Built-in themes sit on the panel's own token layer; copy one to customise colours, shape and CSS', holding a table with columns 'Theme', 'Palette', 'Base', 'Overrides' and 'In use by'. The theme cell shows the display name, its slug in monospace and small pills 'built-in', 'panel default', 'account default', 'custom CSS' and an enabled or disabled pill; the palette cell is a five-colour strip; 'In use by' reads '2 package(s) · 14 account(s) · 3 user(s)'. Each row has a '...' menu: 'Edit', 'View', 'Copy', 'Set as panel default', 'Set as account default', 'Disable', 'Delete'. Empty state 'Installed themes appear here'.
```

Sub-screens (7):

- **Create a theme**

  ```text
  Modal dialog 'Create a theme' with fields 'Slug' (required, help 'Lowercase letters, digits, "-" and "_" (max 32). Packages reference the theme by slug.', placeholder 'acme-hosting'), 'Display name' placeholder 'Defaults to the source name', 'Start from' theme select with placeholder 'A blank theme', and 'Base scheme' ('Light', 'Dark') only when no source is chosen. Footer buttons 'Cancel' and 'Create'.
  ```

- **Delete theme confirmation**

  ```text
  Confirmation dialog 'Delete theme "Acme Hosting"?' explaining the theme and its CSS override are removed, user preferences fall back to the default, and existing accounts keep the slug in their plan snapshot until their package changes. A filled input asks the operator to type the slug. Buttons 'Cancel' and a red 'Delete'.
  ```

- **Theme editor drill-down**

  ```text
  Drill-down view replacing the table: card 'Edit "Acme Hosting"' subtitled with the slug, source theme and update date. Fields 'Name', 'Base scheme', an 'Availability' switch, a grouped 'Design tokens' list of colour swatch plus text input with 'Reset', and a 'CSS override' code area with 'Upload .css file' and 'Clear CSS'. Buttons 'Save theme', 'Preview on this page', 'Close'.
  ```

- **Read-only theme view**

  ```text
  Drill-down view of a built-in theme: the same editor card with every control greyed out and an information banner 'Built-in themes are read-only. Copy this theme from the list to customise it.' at the top; only 'Preview on this page' and 'Close' remain active.
  ```

- **Defaults tab**

  ```text
  Drill-down view, 'Defaults' tab selected: card 'Default themes' with selects 'Panel default' and 'Default for new accounts', a 'Per-user overrides' switch labelled 'Resellers and users may choose their own theme', a muted line pointing at Panel › Customization for logos and company branding, and buttons 'Save' and 'Reset'.
  ```

- **Package assignment tab**

  ```text
  Drill-down view, 'Package assignment' tab selected: card 'Theme per package' with a table of 'Package', 'Accounts' (right aligned), 'Assigned theme' carrying 'unknown' or 'falls back to …' warning pills, and 'Change' holding a theme select. Empty state 'Packages and their themes appear here once a package exists'.
  ```

- **My preference tab**

  ```text
  Drill-down view, 'My preference' tab selected: card 'Your theme' with rows 'Currently applied' (name, slug and colour strip), 'Source' and 'Per-user overrides', a 'Preferred theme' select showing 'Panel default (jupiter)', and a row of small 'Preview Nebula' style buttons plus 'Stop preview'.
  ```

### 18. Packages

4 screens. Sidebar tile colour for this category is used on its tool cards.

#### Add a Package

`/packages/add-a-package` · form

```text
Desktop admin panel screen, 1440px. Page header 'Add a Package', breadcrumb Home > Packages > Add a Package, favourite star, description 'Create a hosting plan.' No header action buttons. Body: card 'Package' with a required 'Package name' input helped by 'Letters, digits, spaces, underscores, dots and hyphens.'; card 'Resources' subtitle 'Leave a field blank for unlimited.' with a two-column grid of number inputs 'Disk quota (MB)', 'Monthly bandwidth (MB)', 'Max FTP accounts', 'Max email accounts', 'Max hourly emails per domain', 'Max databases', 'Max domains', 'Max subdomains', 'Max parked domains', 'Max addon domains' and 'Inode quota', each placeholder 'Unlimited'; card 'Settings' with dropdowns 'Feature list' and 'Account panel theme', an input 'PHP version' placeholder 'ea-php83', and switches 'Shell access', 'Dedicated IP', 'CGI access' and 'Digest authentication at account creation'. A sticky footer bar holds the primary button 'Add'.
```

#### Delete a Package

`/packages/delete-a-package` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Delete a Package', breadcrumb Home > Packages > Delete a Package, favourite star, description 'Remove an unused plan.' No header action buttons. Body: a single full-width card containing only a table with columns 'Package', 'Disk', 'Bandwidth', 'Feature list' and a right-aligned 'Accounts', each row carrying a '...' menu whose one destructive item reads 'Delete', or 'In use (4)' greyed out when the package has accounts or is named default. Empty state reads 'Packages you add under Add a package will appear here.' Rows show human-readable sizes such as '10 GB' and '100 GB'.
```

Sub-screens (1):

- **Confirm package deletion**

  ```text
  Confirmation dialog 'Delete package "Starter"?' with body text 'Accounts are never deleted with a package; a package in use cannot be removed.' Buttons 'Cancel' and a destructive 'Delete'.
  ```

#### Edit a Package

`/packages/edit-a-package` · form

```text
Desktop admin panel screen, 1440px. Page header 'Edit a Package', breadcrumb Home > Packages > Edit a Package, favourite star, description 'Change plan limits and features.' No header action buttons. Body: card 'Select a package' subtitle 'Its limits and settings appear below once chosen.' with a 'Package' dropdown whose options read 'Starter (4 accounts)'; then, once chosen, card 'Package' with the editable 'Package name' input; card 'Resources' subtitle 'Leave a field blank for unlimited.' with number inputs 'Disk quota (MB)', 'Monthly bandwidth (MB)', 'Max FTP accounts', 'Max email accounts', 'Max hourly emails per domain', 'Max databases', 'Max domains', 'Max subdomains', 'Max parked domains', 'Max addon domains', 'Inode quota'; card 'Settings' with 'Feature list', 'PHP version', 'Account panel theme' and switches 'Shell access', 'Dedicated IP', 'CGI access', 'Digest authentication at account creation'; primary button 'Save changes'.
```

#### Feature Manager

`/packages/feature-manager` · config

```text
Desktop admin panel screen, 1440px. Page header 'Feature Manager', breadcrumb Home > Packages > Feature Manager, favourite star, description 'Which account-panel features each plan includes.' No header action buttons. Body: card 'Feature lists' with two side-by-side fields, an 'Edit feature list' dropdown whose options read 'default (6 packages)' and an 'Add a new feature list' field helped by 'Starts as a copy of the list selected on the left.' holding a text input placeholder 'e.g. Business' joined to an 'Add' button; card 'Features in "default"' with small header buttons 'Select all' and 'Select none' and a dense multi-column grid of about fifty labelled switches including 'Addon domains', 'AutoSSL', 'Backups', 'Cron jobs', 'Email accounts', 'File manager', 'MySQL databases', 'Spam filters', 'SSL/TLS', 'Terminal and SSH', 'WordPress installer'; footer buttons primary 'Save' and destructive 'Delete list'.
```

Sub-screens (1):

- **Confirm feature list deletion**

  ```text
  Confirmation dialog titled 'Delete feature list "Business"?' with no body text, showing only the buttons 'Cancel' and a destructive 'Delete'.
  ```

### 19. DNS Functions

14 screens. Sidebar tile colour for this category is used on its tool cards.

#### Add a DNS Zone

`/dns-functions/add-a-dns-zone` · form

```text
Desktop admin panel screen, 1440px. Page header 'Add a DNS Zone', breadcrumb Home > DNS Functions > Add a DNS Zone, favourite star, description 'Creates a zone from a template (SOA, NS, A, MX, www, mail, SPF), validates it with named-checkzone, writes it to BIND and reloads.'. No header actions. Body: a single card titled 'Zone' holding a two-column form of filled inputs and selects: 'Domain' marked required with helper text 'Fully-qualified domain, e.g. example.com' and placeholder example.com, 'IP address' with helper 'Blank uses the account's IP or the server's main IP', 'Account' as a select placeholdered 'Auto-detect from domain' listing username and domain, 'Template' as a select of template names, and 'Default TTL' number input placeholdered 14400 with helper 'Blank = server default'. Footer button row with one primary 'Add zone' button. States: inline red field messages under invalid inputs and a full-width error banner above the form.
```

Sub-screens (1):

- **Zone created result**

  ```text
  Success state replacing the form: a card headed 'Zone example.com created' with an 'Add another' button in the card corner, a key and value list of 'Domain', 'Account', 'Serial', 'TTL', 'Records' and 'Status' with a green 'Published' pill, a monospace block listing each created record name, type and value, and a text link 'Open in DNS Zone Manager'.
  ```

#### Add an A Entry for Your Hostname

`/dns-functions/add-an-a-entry-for-your-hostname` · action

```text
Desktop admin panel screen, 1440px. Page header 'Add an A Entry for Your Hostname', breadcrumb Home > DNS Functions > Add an A Entry for Your Hostname, favourite star, description 'Makes sure the server's hostname has an A record in a zone served here, creating the parent zone from the standard template when needed. The hostname must be fully qualified (set it under Server Configuration > Basic Setup).'. No header actions. Body: one card. At the top a status key and value list: 'Hostname', 'IP to use', 'Configured main IP', 'Zone' as a link, 'Current A record' and 'Resolves publicly'. Below it a narrow filled input labelled 'Override IP address' with helper 'Blank uses the main IP from Basic Setup (or the first detected interface address)'. Below that a single primary button 'Add / update A entry'. States: small warning pills reading 'missing' and green 'yes' pills inside the status list, and an error banner above the result area.
```

Sub-screens (1):

- **Result panel**

  ```text
  Result area appearing inside the card under the button: a key and value list of 'Hostname', 'Record' showing the monospace line server.example.com IN A 203.0.113.10, 'Zone', 'Zone created' and 'Status' with a green 'Published' pill and the serial number beside it.
  ```

#### Delete a DNS Zone

`/dns-functions/delete-a-dns-zone` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Delete a DNS Zone', breadcrumb Home > DNS Functions > Delete a DNS Zone, favourite star, description 'Remove zones from BIND and the panel. Zones still attached to an account are listed too; deleting one of those leaves the account without DNS.'. No header actions. Body: one full-width card containing only a table. A toolbar above the table has a search box placeholdered 'Search zones' and a red 'Delete selected (0)' button. The table has a checkbox selection column and sortable columns 'Zone' in monospace, 'Account', 'Records' right-aligned, 'Serial' in monospace and 'Updated'. Each row ends with a three-dot menu holding a red 'Delete' item. Pagination sits under the table. States: accounts with no owner show an orange 'orphan' pill; empty state reads 'No zones yet. Zones created with Add a DNS Zone or by account creation appear here.'
```

Sub-screens (2):

- **Delete zone confirmation**

  ```text
  Confirmation dialog titled 'Delete zone example.com?' explaining the zone file and stanza are removed from the panel-managed BIND include and named is reloaded, that a hand-declared zone is refused, and that this cannot be undone. It has a type-to-confirm input where the operator types the domain name, a red 'Delete' button and a cancel button.
  ```

- **Delete multiple zones confirmation**

  ```text
  Confirmation dialog titled 'Delete 5 zones?' with the same warning about removing zone files and reloading named and that this cannot be undone, a type-to-confirm input requiring the word DELETE, a red 'Delete' button and a cancel button.
  ```

#### DNS Zone Manager

`/dns-functions/dns-zone-manager` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'DNS Zone Manager', breadcrumb Home > DNS Functions > DNS Zone Manager, favourite star, description 'Edit A, AAAA, CNAME, MX, TXT, SRV, NS, CAA and PTR records, the SOA, or the raw zone file. Every change is validated, written to BIND and reloaded.'. Header action: a primary 'Add a DNS Zone' button with a plus icon. Body: a card titled 'Select a zone' with a 'Filter' input placeholdered 'Type to filter by domain or account' and a 'Zone' select listing domain and owning account. Once a zone is chosen, a second card titled with the domain and subtitled with the owning account and last update shows, in its corner, a green 'Served by BIND' pill and a small 'Re-publish zone' button, a key and value list of 'Serial', 'Default TTL', 'Records' and a 'DNSSEC' pill, and a segmented control 'Records', 'SOA', 'Raw zone file', 'DNSSEC'.
```

Sub-screens (9):

- **Records tab**

  ```text
  Drill-down view below the zone card: a card titled 'Records' with a small primary 'Add record' button in the corner and a filter input placeholdered 'Filter records'. Dense table with columns 'Name', 'TTL', 'Type' as a pill, 'Priority' and 'Value', each row ending in a menu with 'Edit' and a red 'Delete'.
  ```

- **SOA tab**

  ```text
  Drill-down view: card titled 'Start of authority' subtitled that the serial is managed automatically as YYYYMMDDnn, holding a two-column form of 'Primary nameserver', 'Hostmaster (email as a name)', 'Refresh', 'Retry', 'Expire' and 'Minimum (negative cache TTL)', with a primary 'Save SOA' button.
  ```

- **Raw zone file tab**

  ```text
  Drill-down view: card titled 'Raw zone file' with explanatory text, a tall monospace textarea holding the BIND master file, and a button row of 'Validate', primary 'Save zone' and 'Reload from server'. A green validation banner reports record count and serial; a warning banner says the file on disk differs from the database.
  ```

- **DNSSEC tab**

  ```text
  Drill-down view: card titled 'DNSSEC' with a switch labelled 'Sign this zone with DNSSEC' and its description about generating ECDSA P-256 keys. When signed, a key and value list of 'Signed zone', 'Signed', 'Signed serial' and 'Key directory', then headings 'DS records for your registrar' and 'DNSKEY' over monospace blocks, and a small 'Refresh' button.
  ```

- **Add record modal**

  ```text
  Modal dialog titled 'Add record' with fields 'Name' required and helped 'use @ for the zone itself', 'Type' select of A, AAAA, CNAME, MX, TXT, SRV, NS, CAA, PTR, 'TTL' placeholdered 'zone default', a 'Priority' field for MX and SRV, and a wide 'Value' field. Buttons: primary 'Add record' and 'Cancel'.
  ```

- **Edit record modal**

  ```text
  Modal dialog titled 'Edit A record' with the same prefilled fields 'Name', 'Type', 'TTL', optional 'Priority' and 'Value', and buttons primary 'Save record' and 'Cancel'.
  ```

- **Delete record confirmation**

  ```text
  Confirmation dialog titled 'Delete A record?' whose message shows the full record line of name, type, priority and value in monospace, with a red 'Delete' button and a cancel button.
  ```

- **Enable DNSSEC confirmation**

  ```text
  Confirmation dialog titled 'Enable DNSSEC?' explaining keys are generated with dnssec-keygen, the zone is signed on every change, and the DS record must be published at the registrar for validation to work. Buttons: 'Enable' and cancel.
  ```

- **Disable DNSSEC confirmation**

  ```text
  Confirmation dialog titled 'Disable DNSSEC?' warning that the keys and signed zone are deleted and the DS record must be removed at the registrar first or resolvers treat the zone as bogus. Buttons: red 'Disable' and cancel.
  ```

#### Edit Zone Templates

`/dns-functions/edit-zone-templates` · config

```text
Desktop admin panel screen, 1440px. Page header 'Edit Zone Templates', breadcrumb Home > DNS Functions > Edit Zone Templates, favourite star, description 'Templates are rendered when a zone is created (Add a DNS Zone, account creation, parked domains). They must contain an SOA record and render to a valid BIND zone.'. No header actions. Body: a card titled 'Templates' with two side-by-side fields, an 'Edit template' select listing names marked '(built-in)' and a 'Create a new template' input placeholdered 'e.g. ipv6-only' joined to a 'Create' button, helper 'Starts as a copy of the editor contents'. Below it a card titled with the chosen template name, subtitled with its updated date and the substitution variables %domain% %ip% %ipv6% %ns1% %ns2% %serial% %ttl% %hostname%, holding a tall monospace textarea of the template body, a 'Preview with domain' input, and a button row of primary 'Save', 'Preview', 'Reset' and a red 'Delete template'. States: a red banner headed 'Template does not render to a valid zone' listing the errors.
```

Sub-screens (2):

- **Rendered preview**

  ```text
  Expanded state at the bottom of the template card: a heading 'Rendered preview (14 records)' followed by a monospace log block showing the rendered BIND zone file, and, when rendering failed, a red banner headed 'The rendered zone has errors' listing each error as a bullet.
  ```

- **Delete template confirmation**

  ```text
  Confirmation dialog titled 'Delete template "ipv6-only"?' with the message 'Zones already created from it are not affected.', a red 'Delete' button and a cancel button.
  ```

#### Email DNS Record Manager

`/dns-functions/email-dns-record-manager` · config

```text
Desktop admin panel screen, 1440px. Page header 'Email DNS Record Manager', breadcrumb Home > DNS Functions > Email DNS Record Manager, favourite star, description 'Generate and publish SPF, DKIM and DMARC records for a domain. DKIM private keys are stored encrypted and handed to the mail server.'. No header actions. Body: a card 'Select a domain' with a 'Filter' input and a 'Domain' select. Then a card 'Mail exchangers' listing each MX priority and host. Then a card 'SPF', subtitled about which hosts may send mail, with an 'configured' or 'missing' pill, a segmented control 'Builder' and 'Raw', switches for the domain's A/AAAA addresses and mail exchangers, inputs 'Additional IPv4 (ip4:)', 'Additional IPv6 (ip6:)', 'Include (include:)', an 'Everyone else' select, a 'Will publish' preview line and a primary 'Save SPF'. Then a card 'DKIM' with 'Selector' and 'Key size' fields, the published record and buttons 'Generate key and publish', 'Rotate key' and red 'Remove DKIM'. Then a card 'DMARC' with 'Policy (p)', 'Subdomain policy (sp)', 'Aggregate reports (rua)', 'Forensic reports (ruf)', 'Percentage (pct)', 'DKIM alignment (adkim)', 'SPF alignment (aspf)' and 'Save DMARC'.
```

Sub-screens (4):

- **SPF raw mode**

  ```text
  Alternate state of the 'SPF' card with the segmented control switched to 'Raw': the builder switches and fields are replaced by one wide input labelled 'SPF record' holding the full v=spf1 string, with the 'Will publish' and 'Currently' preview lines and the primary 'Save SPF' button below.
  ```

- **Rotate DKIM key confirmation**

  ```text
  Confirmation dialog titled 'Rotate the DKIM key?' warning that mail signed with the old key fails verification once the new public key is published and that the mail server must pick up the new private key. Buttons: red 'Rotate' and cancel.
  ```

- **Remove DKIM confirmation**

  ```text
  Confirmation dialog titled 'Remove DKIM?' with the message 'Deletes the stored private key and the public TXT record.', a red 'Remove' button and a cancel button.
  ```

- **No mail exchangers state**

  ```text
  Empty state inside the 'Mail exchangers' card: muted text reading 'No MX records yet. Set them under Email Routing Configuration.' with the page name as a text link.
  ```

#### Email Routing Configuration

`/dns-functions/email-routing-configuration` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Email Routing Configuration', breadcrumb Home > DNS Functions > Email Routing Configuration, favourite star, description 'Choose, per domain, whether this server, a remote provider or a backup arrangement receives mail. The MX records in the zone are updated to match and the mail server is told about the routing.'. No header actions. Body: one full-width card holding only a table, with a search box above it placeholdered 'Filter domains'. Columns: 'Domain' in monospace, 'Account', 'Routing' as a status pill reading 'Local mail exchanger', 'Backup mail exchanger', 'Remote mail exchanger' or 'Detect automatically', 'Effective' as a pill showing values like 'auto to local', and 'MX records' listing priority and host in small monospace. Each row ends with a three-dot menu holding 'Configure'. States: dashes for domains with no account or no MX; empty state reads 'No zones yet. Each zone appears here with its mail routing once one is added.'
```

Sub-screens (2):

- **Email routing modal**

  ```text
  Large modal dialog titled 'Email routing for example.com' with a radio list of four options, each with a description: 'Local mail exchanger', 'Backup mail exchanger', 'Remote mail exchanger' and 'Detect automatically'. Footer buttons: primary 'Save routing' and 'Cancel'.
  ```

- **Email routing modal, external exchangers**

  ```text
  Same modal with 'Remote mail exchanger' selected, revealing a section headed 'External mail exchangers' with the note 'Lowest priority is tried first', repeating rows of a 'Priority' number field and a 'Mail exchanger host' input joined to a 'Remove' button, plus a small 'Add exchanger' button.
  ```

#### Enable DKIM/SPF Globally

`/dns-functions/enable-dkim-spf-globally` · action

```text
Desktop admin panel screen, 1440px. Page header 'Enable DKIM/SPF Globally', breadcrumb Home > DNS Functions > Enable DKIM/SPF Globally, favourite star, description 'Bulk-apply SPF, DKIM (new keys where missing) and optionally a monitoring DMARC policy to every zone, as a background job.'. No header actions. Body: a card 'What to enable' with a row of four stat tiles labelled 'Zones', 'Missing SPF', 'Missing DKIM' and 'Missing DMARC', then three switches stacked with descriptions: 'SPF', 'DKIM' and 'DMARC (p=none)', and a primary button reading 'Enable on all domains'. Below it a card 'Current status' holding a dense table with a checkbox column and columns 'Domain' as a monospace link, 'Account', 'SPF', 'DKIM' and 'DMARC' each as a pill reading 'yes', 'missing' or 'none', and 'MX' right-aligned. Empty state reads 'No zones yet.'
```

Sub-screens (2):

- **Enable confirmation**

  ```text
  Confirmation dialog titled 'Enable email authentication?' whose message says it adds SPF, DKIM keys and DMARC to all domains that lack them, then reloads BIND, and that existing records are left unchanged. Buttons: 'Run' and cancel.
  ```

- **Running job state**

  ```text
  Alternate state of the 'What to enable' card with a running background job below the button: a progress bar with a percentage, the current step line, and a scrolling monospace log of per-domain output lines.
  ```

#### Nameserver Record Report

`/dns-functions/nameserver-record-report` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Nameserver Record Report', breadcrumb Home > DNS Functions > Nameserver Record Report, favourite star, description 'Compares each zone's NS records with the delegation published by the registrar, checks that every nameserver has an address (glue) and that the public A record matches the zone. Lookups use the configured resolvers.'. No header actions. Body: a card 'Run report' with two fields side by side, 'Single domain (optional)' placeholdered example.com and 'Max zones to check' with helper 'Each zone needs several DNS lookups', a primary 'Check nameservers' button, and under it a key and value list of 'Resolvers', 'Expected nameservers' and 'Zones checked'. Then a card 'Results' with an 'Only problems' switch in its corner and a dense table of 'Status' as a pill, 'Zone' as a monospace link, 'NS in zone', 'Delegated NS' and 'Issues'; each row ends with a menu item 'Details'.
```

Sub-screens (2):

- **Zone details modal**

  ```text
  Large modal dialog titled 'Nameserver report: example.com' with a key and value list of 'Zone NS', 'Delegated NS', 'Zone A' and 'Public A', a heading 'Glue addresses' over a list of nameserver hosts and their addresses, and a heading 'Issues' over a list where each line carries a severity pill and the issue message.
  ```

- **Healthy empty state**

  ```text
  Empty state inside the 'Results' table with the 'Only problems' switch turned on: centred message reading 'Every checked zone looks healthy.' The alternate wording, before any report is run, reads 'No zones to report on. Add a zone and run the report again.'
  ```

#### Park a Domain

`/dns-functions/park-a-domain` · form

```text
Desktop admin panel screen, 1440px. Page header 'Park a Domain', breadcrumb Home > DNS Functions > Park a Domain, favourite star, description 'A parked (alias) domain shows the same site as an account's main domain. The panel records the alias, creates its DNS zone and asks the web server to add the alias to the vhost.'. No header actions. Body: a card 'Park a domain' with a 'Filter' input and a 'Park onto account' select at the top, then two fields side by side, 'Domain to park' marked required and placeholdered example.net and 'IP address' with helper 'Blank uses the account's IP', then a switch 'Create a DNS zone for the domain' described 'Turn off when DNS is hosted elsewhere', and a primary 'Park domain' button. Below it a card 'Parked domains' holding a table with a search box and sortable columns 'Parked domain', 'Account', 'Serves', 'DNS zone' as a pill reading 'here' or 'external', and 'Added'; each row ends with a menu holding a red 'Remove'. Empty state reads 'No parked domains yet. Domains parked with the form above appear here.'
```

Sub-screens (2):

- **Park result panel**

  ```text
  Result area inside the 'Park a domain' card after submitting: a key and value list of 'Parked' in monospace, 'Serves', 'Document root', 'DNS zone' with a green 'Published' pill, and 'Web server alias' with a pill reading 'applied', 'pending' or 'failed'.
  ```

- **Remove parked domain confirmation**

  ```text
  Confirmation dialog titled 'Remove parked domain example.net?' with the message 'The alias is removed from the account and its DNS zone is deleted.', a red 'Remove' button and a cancel button.
  ```

#### Perform a DNS Cleanup

`/dns-functions/perform-a-dns-cleanup` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Perform a DNS Cleanup', breadcrumb Home > DNS Functions > Perform a DNS Cleanup, favourite star, description 'Finds zones that no account owns any more (left behind by terminated accounts or manual edits), zone files on disk the panel does not know about, and zones missing from disk.'. Header action: a 'Re-scan' button. Body: a row of four stat tiles labelled 'Zones', 'Orphaned', 'Unmanaged on disk' and 'Missing on disk'. Then a card 'Orphaned zones' subtitled 'Zones with no account and no hosted domain behind them' with two small red buttons 'Delete selected (0)' and 'Delete all orphans' in its corner, and a dense checkbox table of 'Zone', 'Why', 'Serial' and 'Last change' with a red 'Delete' row menu item. Then a card 'Zone files not known to the panel' with columns 'File / zone' and 'Path'. Then a card 'Zones missing on disk' with columns 'Zone' and 'Account' and a primary 'Rewrite missing files' button.
```

Sub-screens (3):

- **Cleanup confirmation**

  ```text
  Confirmation dialog titled 'Run DNS cleanup?' whose message says it will delete the orphaned zones from BIND and rewrite the zone files missing on disk, and that deleting a zone cannot be undone. It has a type-to-confirm input requiring the word CLEANUP, a red 'Run cleanup' button and a cancel button.
  ```

- **BIND not installed state**

  ```text
  Alternate state replacing the two disk cards: a card holding an empty state titled 'BIND is not installed' with the body text 'Once BIND is installed, this page also lists zone files on disk the panel does not know about and zones missing from disk.' The stat tiles for the disk counts show dashes.
  ```

- **Last cleanup card**

  ```text
  Card titled 'Last cleanup' appearing at the bottom after a run: a key and value list of one line per zone, each with a pill reading 'removed', 'rewritten', the failure reason, or 'skipped (not an orphan)'.
  ```

#### Set Zone TTL

`/dns-functions/set-zone-ttl` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Set Zone TTL', breadcrumb Home > DNS Functions > Set Zone TTL, favourite star, description 'Sets the $TTL of selected zones (the default time-to-live for records without their own). Lower it before migrations, raise it afterwards.'. No header actions. Body: a card titled 'New TTL' with one select labelled 'TTL' offering '5 minutes (300)', '15 minutes (900)', '1 hour (3600)', '4 hours (14400, default)', '1 day (86400)' and 'Custom...'. Below it a full-width card holding only a table, with a search box and a primary 'Apply to selected (0)' button above it. The table has a checkbox column and sortable columns 'Zone' in monospace, 'Account', 'Current TTL' right-aligned and 'Last result'. Each row ends with a menu item reading 'Set 14400s'. States: result cells show a green 'Published' pill with the serial, an orange 'Not published' pill, or a red failure pill; empty state reads 'No zones yet. Zones appear here once one is added, with their current TTL.'
```

Sub-screens (1):

- **Custom TTL state**

  ```text
  Alternate state of the 'New TTL' card with 'Custom...' chosen in the TTL select: a second field labelled 'Seconds' appears beside it as a number input holding the custom value, and the row menu label in the table updates to match the entered number.
  ```

#### Setup/Edit Domain Forwarding

`/dns-functions/setup-edit-domain-forwarding` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Setup/Edit Domain Forwarding', breadcrumb Home > DNS Functions > Setup/Edit Domain Forwarding, favourite star, description 'HTTP redirects for whole domains. Redirects are stored here and applied to the web server's virtual hosts; when the web module is unavailable they wait as pending.'. Header actions: a primary 'Add redirect' button and an 'Apply pending (3)' button. Body: one full-width card holding only a table, with a search box above it. Sortable columns: 'Domain' in monospace, 'Redirects to' as a link, 'Type' showing 301 or 302, 'www' showing yes or no, 'Account', 'Status' as a pill reading 'applied' or 'pending' with any error text beside it, and 'Updated'. Each row ends with a menu holding 'Edit' and a red 'Remove'. States: empty state reads 'No domain redirects yet. Redirects added with the button above appear here with their status.'
```

Sub-screens (4):

- **Add redirect modal**

  ```text
  Modal dialog titled 'Add a domain redirect' with fields 'Domain' required and placeholdered old-site.com, 'Redirect to' required with helper 'Absolute URL', a 'Type' select of 'Permanent (301)' and 'Temporary (302)', a switch 'Also redirect www.<domain>' and a switch 'Keep the request path'. Buttons: primary 'Add redirect' and 'Cancel'.
  ```

- **Edit redirect modal**

  ```text
  Modal dialog titled 'Edit redirect for old-site.com' with the same fields prefilled and the 'Domain' input disabled, the 'Redirect to' and 'Type' fields editable, both switches set, and buttons primary 'Save' and 'Cancel'.
  ```

- **Remove redirect confirmation**

  ```text
  Confirmation dialog titled 'Remove the redirect for old-site.com?' with no body text, a red 'Remove' button and a cancel button.
  ```

- **Web module unavailable banner**

  ```text
  Information banner across the top of the body, above the table, headed 'Web server integration not loaded' with the body line 'Redirects are recorded and will be written to the vhosts as soon as the web server module is available.' and an info icon.
  ```

#### Synchronize DNS Records

`/dns-functions/synchronize-dns-records` · progress-log

```text
Desktop admin panel screen, 1440px. Page header 'Synchronize DNS Records', breadcrumb Home > DNS Functions > Synchronize DNS Records, favourite star, description 'Pushes zones to the nameservers in your DNS cluster over their panel API, so every peer serves the same records. Synchronization is push-only: changes made on a peer are not pulled back. The hourly run only sends zones a peer has not acknowledged at their current serial; this page pushes everything you select.'. Header action: a 'Refresh' button. Body: a card 'Cluster peers' holding a dense table of 'Peer', 'Host' in monospace, 'Role' as a pill, 'Enabled', 'API token' as a pill reading 'set' or 'missing', and 'Last sync'. Then a card 'Synchronize now' with a 'Peer' select placeholdered 'All peers', a 'Zones' input helped 'Comma-separated; blank pushes every zone', and a primary 'Synchronize DNS records' button. Then a card 'Zone sync status' with columns 'Zone', 'Peer', 'Status' as a pill reading 'in sync', 'stale' or 'failed', 'Pushed serial', 'Current serial', 'Via', 'Message' and 'When'.
```

Sub-screens (3):

- **No peers empty state**

  ```text
  Empty state inside the 'Cluster peers' card: title 'No DNS cluster peers configured' with body text saying peers appear here once nameservers are added under Clusters > DNS Cluster, rendered as a text link, and that each needs the peer's address and an API token for its root user.
  ```

- **Running sync job**

  ```text
  Alternate state of the 'Synchronize now' card: below the button a running background job shows a progress bar with a percentage, the current step line naming the peer and zone, and a scrolling monospace log of per-zone push results.
  ```

- **Empty sync status**

  ```text
  Empty state inside the 'Zone sync status' table reading 'Nothing has been synchronized yet. Each zone and peer appears here after the first push.' with the column headers still visible above it.
  ```

### 20. Database Services

12 screens. Sidebar tile colour for this category is used on its tool cards.

#### Change Database Root Password

`/database-services/change-database-root-password` · form

```text
Desktop admin panel screen, 1440px. Page header 'Change Database Root Password', breadcrumb Home > Database Services > Change Database Root Password, favourite star, description 'Rotate the database superuser password on the active profile. The panel keeps its own stored credentials in sync so account provisioning keeps working.'. No header action buttons. Body: a four-tile strip reading 'Active profile', 'Server', 'Service' and 'Managed', showing the profile name with engine and host, the running version, a service unit state pill, and a databases/users count. Below it one card 'New root password' holding a key/value list 'Profile', 'Engine', 'Host', 'Admin user', then a required masked field 'New password' with a strength meter and a generate button, help 'Minimum strength 65; use the generator for a random password.', and a red button 'Change root password'. After success a key/value block shows 'Result' with a green 'changed' pill, 'Hosts updated', '/root/.my.cnf' reading 'rewritten (0600)', and 'Stored profile credentials'. A red error banner sits above the form when the password is too weak.
```

Sub-screens (1):

- **Confirm root password change**

  ```text
  Confirmation dialog 'Change the root password?' with body text explaining the root password is changed at every host it exists at and /root/.my.cnf is rewritten so root tooling keeps working, and that anything else using the old password (backups, the phpMyAdmin control user, remote tools) must be updated. Buttons 'Cancel' and a red 'Change password'.
  ```

#### Change Database User Password

`/database-services/change-database-user-password` · form

```text
Desktop admin panel screen, 1440px. Page header 'Change Database User Password', breadcrumb Home > Database Services > Change Database User Password, favourite star, description 'Reset the password of a database user at every host it exists at. Resellers can change users that belong to their own accounts.'. No header action buttons. Body: a four-tile strip reading 'Active profile', 'Server', 'Service' and 'Managed' with the profile name, running version, a service state pill and a databases/users count. Below it a single card 'Select a user' containing a dropdown 'Database user' whose options read like 'shop_app — shopco' and whose help line reads '12 users', then a required masked field 'New password' with a strength meter and generate button, and a primary button 'Change password', disabled until both are filled. After success a key/value block shows 'Result' with a green 'changed' pill, 'User', 'Hosts' and 'Account'. A red error banner appears above the form for weak passwords.
```

#### Database Map Tool

`/database-services/database-map-tool` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Database Map Tool', breadcrumb Home > Database Services > Database Map Tool, favourite star, description 'Map databases and database users that exist on the server to hosting accounts, so quotas, backups, transfers and terminations know what belongs to whom. Objects created through the panel are mapped automatically; use this tool for databases created by hand or migrated in.'. Header action: a 'Refresh' button. Body: an optional amber banner 'Server unreachable' saying only the panel's own records are shown; a filter row with a switch 'Show unmapped only' and muted text '3 unmapped database(s), 2 unmapped user(s) · suggestions use the <account>_ prefix'; then a card 'Databases' with a small 'Apply all suggestions' button and a table of 'Database', 'Size', 'On server' and 'Mapped to account', the last column holding an account dropdown placeholdered 'Unmapped' beside a small 'Use shopco' suggestion button; then a card 'Database users' laid out the same way with columns 'User', 'Hosts', 'On server' and 'Mapped to account'. 'On server' shows a green 'yes' or red 'missing' pill. Empty state: 'Every database is mapped to an account.'
```

#### Edit Database Configuration

`/database-services/edit-database-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Edit Database Configuration', breadcrumb Home > Database Services > Edit Database Configuration, favourite star, description 'Tune the local MySQL/MariaDB server through a panel-managed include file that overrides the distribution defaults. Changes are validated with the server binary and rolled back if rejected; a restart applies them.'. Header actions: 'Refresh' and a red 'Restart server'. Body: card 'Server status' with four tiles 'Unit', 'Uptime', 'Connections' (with a 'max used' sub-line) and 'Slow queries', plus a key/value list 'Managed include', 'Main configuration', 'Configuration directories'. Card 'Options', subtitle 'Blank keeps the distribution default. Values are written to the [mysqld] section of the managed include.', holding a table of 'Option', 'Description', 'Running value' and 'Override' where each override is a text input, custom rows carrying a red 'Remove'; underneath, fields 'Add another option' and 'Value' with an 'Add option' button, then 'Save configuration', 'Reset' and a switch 'Restart the server after saving'. Card 'Managed include contents' shows a monospace file listing. Card 'Distribution [mysqld] settings', subtitle 'What the server reads before the managed include; overrides above win.' A blue banner 'Not available for the active profile' replaces everything for PostgreSQL.
```

Sub-screens (2):

- **Confirm save and restart**

  ```text
  Confirmation dialog 'Save and restart the database server?' with body text 'The managed include is validated with the server binary before the restart. Connections are dropped for a few seconds while it restarts.' Buttons 'Cancel' and a red 'Save and restart'.
  ```

- **Confirm restart server**

  ```text
  Confirmation dialog 'Restart the database server?' with body text 'Active connections are dropped briefly.' Buttons 'Cancel' and a red 'Restart'. Opened from the 'Restart server' button in the page header; it carries no fields of its own.
  ```

#### Manage Database Access Hosts

`/database-services/manage-database-access-hosts` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Database Access Hosts', breadcrumb Home > Database Services > Manage Database Access Hosts, favourite star, description 'Remote hosts that may connect to an account's databases. Each host becomes a user@host entry with the same password and privileges as the localhost user, so applications on other servers can connect. Make sure the server listens on a reachable address (bind_address) and the firewall allows port 3306.'. Header action: 'Refresh'. Body: a four-tile strip 'Active profile', 'Server', 'Service', 'Managed'; optional blue banners about a PostgreSQL profile using pg_hba.conf and about hosts marked 'all accounts' being removable only by root. Card 'Allow a remote host' with a 'Scope' dropdown placeholdered 'All accounts (global, root only)' and a required 'Remote host' field, help 'IP address, hostname or wildcard pattern (203.0.113.% or %.example.com). localhost is always allowed.', then a primary 'Allow host' button and a green success banner. Card 'Access hosts' with a table of 'Host', 'Scope' (pill reading 'all accounts' or the account name) and 'Added', each row having a '...' menu with 'Remove'. Empty state: 'No remote hosts yet; only localhost can connect. Hosts you allow appear here.'
```

Sub-screens (1):

- **Confirm remove access host**

  ```text
  Confirmation dialog 'Remove 203.0.113.5?' with body text saying database users of that account, or of every account, lose access from this host and their user@host entries are dropped. Buttons 'Cancel' and a red 'Remove host'.
  ```

#### Manage Database Profiles

`/database-services/manage-database-profiles` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Database Profiles', breadcrumb Home > Database Services > Manage Database Profiles, favourite star, description 'Connection profiles for local and remote database servers. The active profile is the server every database function uses. Credentials are stored encrypted; the local profile may leave them blank to use /root/.my.cnf or socket authentication.'. Header actions: 'Refresh' and a primary 'Add profile'. Body: a single card 'Profiles' filling the page with a table of 'Profile' (bold name plus a green 'active' pill), 'Engine' reading MariaDB, MySQL or PostgreSQL, 'Server' showing host:port with a 'local' or 'remote' note, 'Credentials' showing the admin user with a 'password stored' or 'no password' pill or the muted text '/root/.my.cnf or socket', and 'Last test' showing a 'reachable' or 'failed' pill beside the version and the test timestamp, or 'never tested'. Each row has a '...' menu with 'Test connection', 'Activate', 'Edit' and a red 'Delete'. Empty state: 'No profiles yet. Add one and it appears here; the active profile is the server every database function uses.'
```

Sub-screens (3):

- **Add or edit profile modal**

  ```text
  Modal dialog titled 'Add database profile', or 'Edit Primary MariaDB' when editing. Two-column form with 'Profile name', an 'Engine' dropdown offering MariaDB, MySQL and PostgreSQL, 'Host', 'Port', 'Admin user' and a masked 'Admin password', each with help text about sockets, default ports and encrypted storage. Footer buttons 'Cancel' and 'Create profile'.
  ```

- **Confirm activate profile**

  ```text
  Confirmation dialog 'Activate Primary MariaDB?' with body text 'Every database function (create, grants, processes, repair…) will run against this server from now on.' Buttons 'Cancel' and 'Activate'. Opened from the row menu of the profiles table.
  ```

- **Confirm delete profile**

  ```text
  Confirmation dialog 'Delete profile Primary MariaDB?' with body text saying only the panel's connection profile is removed and the database server and its data are untouched. Buttons 'Cancel' and a red 'Delete'.
  ```

#### Manage Database Users

`/database-services/manage-database-users` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Database Users', breadcrumb Home > Database Services > Manage Database Users, favourite star, description 'Create database users, set their privileges per database and rotate their passwords. Users created for an account are prefixed with the account name and provisioned at localhost plus every allowed remote access host.'. Header action: 'Refresh'. Body: a four-tile strip 'Active profile', 'Server', 'Service', 'Managed'. Card 'Create a database user' with an 'Owner account' dropdown, a required 'User name' field helped by 'Will be created as shopco_…', a required masked 'Password' with strength meter, an optional 'Hosts' field, then 'Grant all privileges on' holding a grid of database checkboxes and a primary 'Create user'. Card 'Database users' with a search box 'Search users or accounts', a toolbar switch 'Show system users', and a paginated table of 'User', 'Account', 'Hosts', 'Privileges' and 'State' with a green 'present' or red 'missing on server' pill. Row '...' menus offer 'Privileges', 'Change password' and a red 'Drop'. Empty state: 'No database users yet. Users you create or map to accounts appear here.'
```

Sub-screens (3):

- **Privileges modal**

  ```text
  Large modal dialog 'Privileges for shopco_app'. A line listing the hosts the privileges apply at, an amber banner when privileges differ per host, then one card per granted database holding a grid of privilege checkboxes such as 'ALL PRIVILEGES', 'ALTER', 'CREATE', 'DELETE', 'DROP', 'INSERT', 'SELECT' and 'UPDATE', each with a 'Remove' button. Below, an 'Add a database' dropdown and 'Add with all privileges'. Footer 'Cancel' and 'Save privileges'.
  ```

- **Change password modal**

  ```text
  Small modal dialog 'Change password for shopco_app' with a required masked 'New password' field showing a strength meter and generate button, and the note 'Applied at every host the user exists at. Update the application configuration afterwards.' Footer buttons 'Cancel' and 'Change password'.
  ```

- **Confirm drop user**

  ```text
  Confirmation dialog 'Drop user shopco_app?' with body text saying the user is removed at every host, listed by name, together with its privileges, and that applications using it will lose access. Buttons 'Cancel' and a red 'Drop user'.
  ```

#### Manage Databases

`/database-services/manage-databases` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Databases', breadcrumb Home > Database Services > Manage Databases, favourite star, description 'Create and drop databases on the active database server. Databases created for an account are prefixed with the account name and count against the package's database limit.'. Header action: 'Refresh'. Body: a four-tile strip 'Active profile', 'Server', 'Service', 'Managed'. Card 'Create a database' with an 'Owner account' dropdown and a required 'Database name' field helped by 'Will be created as shopco_…', plus a primary 'Create database'. Card 'Databases' with a search box 'Search databases or accounts', a toolbar switch 'Show system databases', and a paginated, sortable table of 'Database', 'Account', 'Users with access', 'Size', 'Tables', 'Charset' and 'State', where state is a green 'present', red 'missing on server' or grey 'server unreachable' pill and unowned rows read 'unmapped'. Row '...' menu has a red 'Drop'. An amber 'Server unreachable' banner and a PostgreSQL ownership note sit at the card foot. Empty state: 'No databases yet. Databases you create or map to accounts appear here.'
```

Sub-screens (1):

- **Confirm drop database**

  ```text
  Confirmation dialog 'Drop database shopco_shop?' with body text 'Every table and all data in this database are deleted permanently. Type the database name to confirm.' and a text field where that exact name must be typed. Buttons 'Cancel' and a red 'Drop database' that stays disabled until the name matches.
  ```

#### phpMyAdmin

`/database-services/phpmyadmin` · action

```text
Desktop admin panel screen, 1440px. Page header 'phpMyAdmin', breadcrumb Home > Database Services > phpMyAdmin, favourite star, description 'Web-based database administration. The panel detects a phpMyAdmin installation and the web server alias that serves it; with single sign-on you open it signed in as the administrator (every database) or as one of your accounts (that account's databases only).'. Header action: 'Refresh'. Body: card 'Status' with a primary action button 'Open phpMyAdmin (all databases)' and a key/value list 'Installed', 'Location', 'Configuration', 'Served at', 'URL', 'PHP' and 'Single sign-on', each value carrying a state pill such as 'yes — version 5.2.1', 'installed' or 'on — links open signed in'; below it an amber banner 'phpMyAdmin is not installed' with an install button, and blue banners about a missing web server alias and about single sign-on being off. Card 'Open as an account', subtitle about seeing exactly what a customer sees, with a 'Filter' box, an 'Account' dropdown and a primary 'Open as account'. Card 'Web server configuration' with a table of 'File', 'Server', 'Alias' and 'Enabled'. Card 'URL override' with a 'phpMyAdmin URL' field and 'Save'.
```

#### Repair Databases

`/database-services/repair-databases` · progress-log

```text
Desktop admin panel screen, 1440px. Page header 'Repair Databases', breadcrumb Home > Database Services > Repair Databases, favourite star, description 'Check, repair, optimize or analyze tables with mysqlcheck as a background job. Leave the selection empty to process every database you manage (root: all databases on the server).'. Header action: 'Refresh'. Body: a four-tile strip 'Active profile', 'Server', 'Service', 'Managed'. Card 'Run' holding an 'Operation' dropdown listing 'Check (mysqlcheck --check)', 'Repair (mysqlcheck --repair)', 'Optimize (mysqlcheck --optimize)' and 'Analyze (mysqlcheck --analyze)', a switch 'Repair tables found corrupt (--auto-repair)', a 'Databases' field with 'Select all' and 'Clear' buttons above a grid of database checkboxes each showing its account, and a 'Run check' button. Underneath, a live job panel with a status pill, a progress bar with percentage and a scrolling monospace log, then result tiles 'Tables', 'OK', 'Repaired', 'Warnings', 'Errors' and a table of 'Table', 'Status', 'Messages'. Card 'Recent runs' lists 'Started', 'Operation', 'Databases', 'Job', 'Result' and 'By'. Empty state: 'No runs yet. Finished checks and repairs appear here.'
```

Sub-screens (1):

- **Confirm destructive operation**

  ```text
  Confirmation dialog titled with the chosen operation, for example 'Repair (mysqlcheck --repair)?', with body text 'Tables are locked while repair runs; applications may stall until it finishes.' Buttons 'Cancel' and 'Run'. Shown for repair, optimize and analyze only, never for a plain check.
  ```

#### Show Database Processes

`/database-services/show-database-processes` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Show Database Processes', breadcrumb Home > Database Services > Show Database Processes, favourite star, description 'Live connections and running statements on the active database server (SHOW PROCESSLIST). Kill a runaway query or an idle connection.'. Header actions: a switch 'Auto-refresh (5s)' and a 'Refresh' button. Body: one card whose title counts the rows and names the server, reading like '14 processes on Primary MariaDB (MariaDB)', with a switch 'Hide sleeping' in its corner. Inside, a dense table of 'ID', 'User', 'Host', 'Database', 'Command', 'Time', 'State' and 'Statement', where 'Command' is a pill that is grey for sleeping or idle and active otherwise, time is shown as seconds or a duration, and long statements are truncated in monospace. Each row has a '...' menu with a red 'Kill query' and a red 'Kill connection'. Empty state: 'No client connections right now. Open connections and running statements appear here.' A capability notice replaces the card when no database server is installed.
```

Sub-screens (2):

- **Confirm kill query**

  ```text
  Confirmation dialog 'Kill query 48213?' with body text 'The running statement is aborted; the connection stays open.' Buttons 'Cancel' and a red 'Kill'. Opened from the row menu of the process table.
  ```

- **Confirm kill connection**

  ```text
  Confirmation dialog 'Kill connection 48213?' with body text saying the connection of that user at that host is closed and its statement rolled back. Buttons 'Cancel' and a red 'Kill'.
  ```

#### Upgrade Database Version

`/database-services/upgrade-database-version` · progress-log

```text
Desktop admin panel screen, 1440px. Page header 'Upgrade Database Version', breadcrumb Home > Database Services > Upgrade Database Version, favourite star, description 'Upgrade the local MySQL/MariaDB server through the distribution package manager, with a full dump beforehand and mysql_upgrade afterwards. Switching between MySQL and MariaDB is a reinstall: back up, remove the old server packages, then install the new one.'. Header action: 'Refresh'. Body: card 'Current server' with an optional amber banner 'Server not reachable' and a key/value list 'Profile', 'Running version', 'Package manager' with a detected or 'not detected' pill, 'Installed server packages' and 'Pre-upgrade backups' showing the backup path. Card 'Upgrade' with a blue banner when the active profile is remote, a 'Target package' dropdown whose options read like 'mariadb-server → 10.11.6 (installed 10.6.18)' plus 'Other package…', a 'Package name' field, a switch 'Dump all databases before upgrading' described as mysqldump --all-databases, and a red 'Upgrade database server' button, followed by a live job panel with status pill, progress bar and monospace log. Card 'Recent upgrade jobs' tables 'Started', 'Target', 'Job' and 'Result'.
```

Sub-screens (1):

- **Confirm upgrade**

  ```text
  Confirmation dialog 'Upgrade to mariadb-server?' explaining all databases are dumped to the backup directory first, the package is installed through the system package manager, the server restarts and system tables are upgraded, and that downgrades are not supported so the backup should be kept. A field requires typing 'UPGRADE'. Buttons 'Cancel' and a red 'Start upgrade'.
  ```

### 21. IP Functions

9 screens. Sidebar tile colour for this category is used on its tool cards.

#### IPv6 Ranges

`/ip-functions/ipv6-ranges` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'IPv6 Ranges', breadcrumb Home > IP Functions > IPv6 Ranges, favourite star, description 'IPv6 ranges are networks delegated to this server (for example a /64 from your provider). Enabled ranges feed Assign IPv6 Address; map a range to accounts to let their resellers draw from it.' Header actions: none. Body: card 'Add a range' with filled inputs 'Name', 'Range (CIDR)' helped by '/16 to /126; the network address is never assigned', an 'Interface' dropdown and a 'Notes' input, a switch 'Enabled' described as 'Disabled ranges keep their assignments but hand out no new addresses', and an 'Add range' button. Card 'IPv6 ranges' with an 'Assign addresses' link button and a table of columns 'Name', 'Range', 'State', 'Interface', 'Assigned', 'Accounts allowed' and 'Notes', each row carrying a '...' menu of 'Edit', 'Accounts', 'Disable' and 'Delete'. States: pills read 'enabled' and 'disabled', interface falls back to 'auto', accounts to 'any (root only)', and the empty table reads 'No IPv6 ranges yet. Ranges you add above appear here.'
```

Sub-screens (3):

- **Edit range**

  ```text
  Modal dialog 'Edit range "customers"' with inputs 'Name', 'Range (CIDR)' disabled while addresses are assigned, an 'Interface' dropdown, a 'Notes' textarea and an 'Enabled' switch, plus a key/value block showing 'First / last', 'Size' and 'Next free' addresses. Buttons 'Save' and 'Cancel'.
  ```

- **Accounts allowed to use a range**

  ```text
  Wide modal dialog 'Accounts allowed to use "customers"' noting root may assign from any enabled range while resellers are limited to mapped ones, over a searchable selectable table with columns 'Account', 'Domain', 'Owner' and 'IPv4'. Buttons 'Save' and 'Cancel'.
  ```

- **Confirm delete range**

  ```text
  Confirmation dialog 'Delete range "customers"?' saying 2001:db8:1::/64 is removed from the panel, addresses already bound from it are untouched and ranges with assigned addresses cannot be deleted. Buttons 'Delete' in red and 'Cancel'.
  ```

#### Add a New IP Address

`/ip-functions/add-a-new-ip-address` · form

```text
Desktop admin panel screen, 1440px. Page header 'Add a New IP Address', breadcrumb Home > IP Functions > Add a New IP Address, favourite star, description 'Binds one address or a consecutive range to a network interface with iproute2, records it in the panel's inventory and persists it so the panel's boot unit re-adds it after a restart. New addresses start free; reserve them to keep them out of allocation.' Header actions: none. Body: card 'New IP address' with a radio group 'Single address' and 'Range', filled inputs 'IP address' (or 'First address' and 'Last address'), 'Netmask / prefix' and an 'Interface' dropdown, a switch 'Reserve the new addresses' revealing a 'Reservation note' input, and an 'Add IP address' button. Card 'Result' with a key/value list 'Interface', 'Prefix', 'Added', 'Failed' and 'Persisted at boot', over a table of 'Address', 'Family', 'Bound', 'Reserved' and 'Note'. Card 'Currently bound addresses', subtitled with the main IP and the recorded count, with a 'Manage' link and a dense table of 'Address', 'Family', 'Netmask', 'Interface' and 'Role'. States: pills 'bound', 'already bound', 'failed', 'main', 'reserved', 'dedicated'; a notice offers to install iproute2 when the ip command is missing.
```

#### Assign IPv6 Address

`/ip-functions/assign-ipv6-address` · form

```text
Desktop admin panel screen, 1440px. Page header 'Assign IPv6 Address', breadcrumb Home > IP Functions > Assign IPv6 Address, favourite star, description 'Gives an account the next free address from an IPv6 range: the address is bound to the interface, recorded as dedicated to the account, published as AAAA records for the account's domains and passed to the web server when it is available.' Header actions: none. Body: card 'Assign an IPv6 address' with an account picker labelled 'Account', a 'Range' dropdown helped by 'Blank uses the first enabled range mapped to the account', a filled input 'Specific address' helped by 'Blank picks the next free address in the range', and an 'Assign IPv6 address' button; after a run a key/value block shows 'Account', 'Address', 'Range', 'Interface', 'Bound on host', 'DNS (AAAA)' and 'Web server'. Card 'Current IPv6 assignments' with a table of 'Account', 'Domain', 'IPv6 address', 'Range' and 'Assigned', each row carrying a 'Remove' action. States: an information banner says the account already has an address and must have it removed first; the empty table reads 'No account has an IPv6 address yet.'
```

Sub-screens (1):

- **Confirm remove assignment**

  ```text
  Confirmation dialog 'Remove 2001:db8:1::42 from testuser?' saying the address is unbound from the interface, its AAAA records are removed from the account's zones and the web server is told to stop listening on it. Buttons 'Remove' in red and 'Cancel'.
  ```

#### Configure Remote Service IPs

`/ip-functions/configure-remote-service-ips` · config

```text
Desktop admin panel screen, 1440px. Page header 'Configure Remote Service IPs', breadcrumb Home > IP Functions > Configure Remote Service IPs, favourite star, description 'Chooses which of the server's addresses each service uses when it talks to the outside: outgoing mail, DNS lookups and cluster pushes, remote database connections, FTP passive data and the panel's own API calls. Only addresses bound to this server can be selected; the owning service is reconfigured when it is installed.' Header actions: none. Body: one card per service, each titled with the service name and subtitled with its help text, holding two dropdowns side by side, 'IPv4 source address' and 'IPv6 source address', whose first option reads 'Default (main IP / kernel choice)'. Under a saved card a status pill reads 'applied', 'saved' or 'failed' with a muted note 'applied once the service is installed' or the error text. A sticky bottom bar holds 'Save' and 'Reset'. States: an information banner says no managed addresses are bound and links to rebuilding the pool or adding an address.
```

#### IP Migration Wizard

`/ip-functions/ip-migration-wizard` · wizard

```text
Desktop admin panel screen, 1440px. Page header 'IP Migration Wizard', breadcrumb Home > IP Functions > IP Migration Wizard, favourite star, description 'Renumbers the server: every account on an old address moves to the new one, A/AAAA records carrying the old address are rewritten and published, virtual hosts are updated through the web server service, Basic Setup and remote-service IPs follow, and new addresses are bound and persisted. Preview first, then dry-run or migrate.' Header actions: none. Body: a three-step breadcrumb reading '1. Map addresses', '2. Review plan', '3. Run' with the current step bold. Card 'Address mappings' with an 'Add mapping' button and an editable table of 'Old address' and 'New address' inputs with a remove icon per row, then switches 'Rewrite DNS records', 'Rewrite virtual hosts' and 'Remove old addresses', an 'Interface for new addresses' dropdown, a 'Prefix for new addresses' dropdown and a 'Preview migration' button. Card 'Recent migrations' with a dense table of 'Job', 'Mappings', 'Mode', 'Status', 'Result' and 'Started'.
```

Sub-screens (4):

- **Step 1 of 3 — Map addresses**

  ```text
  Step 1 of 3, card 'Address mappings' subtitled 'Old address → new address. Several mappings run in order.' An editable table of 'Old address' and 'New address' inputs with per-row remove icons and an 'Add mapping' button, three switches, two dropdowns and a 'Preview migration' button.
  ```

- **Step 2 of 3 — Review plan**

  ```text
  Step 2 of 3, card 'Migration plan' with stat tiles 'Mappings', 'Accounts', 'DNS records', 'New addresses to bind' and 'Main IP changes', a key/value block for 'iproute2', 'DNS service' and 'Web server service', a warnings banner, and a table of 'Old', 'New', 'Accounts', 'DNS records', 'Flags' and 'Problems'. Buttons 'Back', 'Dry run' and 'Migrate now'.
  ```

- **Step 3 of 3 — Run**

  ```text
  Step 3 of 3, card 'Migration in progress' holding a streaming progress log of the running job. Buttons 'Back to plan', 'Start another migration' and a link button 'Show IP usage'.
  ```

- **Confirm migration**

  ```text
  Confirmation dialog 'Start the IP migration?' stating how many accounts and DNS records are rewritten, how many new addresses are bound, that the main IP changes and whether old addresses are removed or kept reserved. A field asks the admin to type MIGRATE. Buttons 'Migrate' in red and 'Cancel'.
  ```

#### Rebuild the IP Address Pool

`/ip-functions/rebuild-the-ip-address-pool` · action

```text
Desktop admin panel screen, 1440px. Page header 'Rebuild the IP Address Pool', breadcrumb Home > IP Functions > Rebuild the IP Address Pool, favourite star, description 'Compares the addresses bound to the host (ip -j addr) with the panel's inventory: imports addresses the panel did not know about, refreshes interfaces and netmasks, re-detects the main IP and recomputes which addresses are free, shared, dedicated, reserved or missing.' Header actions: none. Body: card 'Rebuild' with a muted paragraph giving the last rebuild time and explaining that nothing is removed from the host and that DHCP, SLAAC and IPv6 privacy addresses are imported as dynamic, then a 'Rebuild the IP address pool' button; after a run a key/value result block reads 'Main IP', 'Source', 'Imported from host', 'Dynamic (DHCP / SLAAC / privacy), not persisted', 'Interface/netmask refreshed', 'Recorded but not on host', 'Dynamic addresses that left the host (forgotten)' and 'Boot persistence'. A row of stat tiles 'Total', 'Main', 'Shared', 'Dedicated', 'Reserved' and 'Free'. Card 'IP address pool' with a dense table of 'Address', 'Family', 'Interface', 'State', 'Account', 'On host' and 'Synced'. States: pills 'main IP', 'free', 'not on host', 'dynamic (host-owned)'; a notice offers to install iproute2.
```

#### Show IP Address Usage

`/ip-functions/show-ip-address-usage` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Show IP Address Usage', breadcrumb Home > IP Functions > Show IP Address Usage, favourite star, description 'Which account uses each address: the main and shared IPs are used by every account without a dedicated address; dedicated IPs belong to one account; reserved ones are held back. Resellers see only the addresses their accounts use.' Header actions: a 'Refresh' button. Body: a row of stat tiles 'Main', 'Shared', 'Dedicated', 'Reserved', 'Free' and 'Dynamic'. Card 'IP address usage', subtitled with the address count and how many are not recorded, with a state dropdown placeholdered 'All states' and a table of columns 'Address', 'Family', 'State', 'On host', 'Dedicated to', 'Accounts' and 'Used by', the last listing up to six account names. Card 'Addresses used by accounts but not in the inventory' with a paragraph pointing at rebuilding the pool or the migration wizard and a key/value list of each address and its accounts. States: pills read 'main IP', 'shared', 'dedicated', 'reserved', 'free', 'dynamic (host-owned)', 'not recorded', 'bound' and 'not bound'; the empty table reads 'No addresses to show.'
```

#### Show or Delete Current IP Addresses

`/ip-functions/show-or-delete-current-ip-addresses` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Show or Delete Current IP Addresses', breadcrumb Home > IP Functions > Show or Delete Current IP Addresses, favourite star, description 'Every address the panel knows about, with its live state on the host. The main IP and addresses in use by accounts, the shared IP or remote services cannot be removed.' Header actions: a 'Refresh' button. Body: card 'Host summary' with a key/value list 'Main IP', 'Default route (IPv4)', 'Default route (IPv6)', 'Address source' and 'Recorded addresses'. Card 'Bound IP addresses' with a family dropdown placeholdered 'All families' and a table of columns 'Address', 'Family', 'Netmask', 'Interface', 'On host', 'Role' and 'Accounts', each row carrying a 'Delete', 'Forget' or disabled 'Protected' action. Card 'Addresses on the host that are not in the inventory', subtitled about DHCP and privacy addresses, with a 'Rebuild pool' link and a dense table of 'Address', 'Family', 'Prefix', 'Interface' and 'Kind'. States: pills 'bound', 'not bound', 'main IP', 'reserved', 'dedicated', 'dynamic'; a notice offers to install iproute2.
```

Sub-screens (2):

- **Confirm remove managed address**

  ```text
  Confirmation dialog 'Remove 203.0.113.20?' saying the address is removed from its interface immediately and dropped from the boot-time inventory, and that sites or services still answering on it will stop responding. A field asks the admin to type the address. Buttons 'Remove address' in red and 'Cancel'.
  ```

- **Confirm forget dynamic address**

  ```text
  Confirmation dialog 'Forget 2001:db8::1?' explaining this is a DHCP, SLAAC or privacy address owned by the host, that it is dropped from the panel's inventory only and stays bound, and that rebuilding the pool imports it again. Buttons 'Forget address' and 'Cancel'.
  ```

#### Show/Edit Reserved IPs

`/ip-functions/show-edit-reserved-ips` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Show/Edit Reserved IPs', breadcrumb Home > IP Functions > Show/Edit Reserved IPs, favourite star, description 'Reserved addresses stay bound to the server but are never handed to accounts as a dedicated or shared IP. The main IP and addresses currently in use cannot be reserved.' Header actions: none. Body: one card 'Reserved IP addresses' holding an editable table with columns 'Reserved', 'Address', 'Family', 'Interface', 'Status' and 'Reason'. The first column is a switch per row, disabled for addresses that cannot be reserved; the status column carries a pill and shows an inline error message under a refused row; the reason column becomes a filled input once a row is switched on and otherwise shows the stored note in muted text. Below the table, buttons 'Save (2 changes)' and 'Reset'. States: pills read 'main IP', 'dedicated', 'shared', 'reserved' and 'free'; the empty table reads 'No addresses recorded yet. Rebuild the IP address pool and every address appears here with its reservation.'
```

### 22. Software

10 screens. Sidebar tile colour for this category is used on its tool cards.

#### Install a Perl Module

`/software/install-a-perl-module` · form

```text
Desktop admin panel screen, 1440px. Page header 'Install a Perl Module', breadcrumb Home > Software > Install a Perl Module, favourite star, description 'Install from CPAN.' No header actions. Body: card 'Install from CPAN' subtitled 'Installer: cpanm · perl 5.38. Modules are built and installed non-interactively as a background job.', holding an amber banner 'No CPAN client' with an inline 'Install cpanminus' button, a required multi-line 'Module names' field helped by 'One per line or separated by spaces, e.g. DBD::mysql, JSON::XS, LWP::UserAgent', a switch 'Skip the module test suites', and a primary 'Install module' button. Card 'Install log' streaming job output. Card 'Installed modules' with a 'Filter modules…' box and a scrolling table 'Module', 'Version', empty state 'No modules are registered yet; modules installed from CPAN appear here'. Card 'Previous installs' listing 'Job', 'Type', 'Status', 'Started', 'Message' with 'Log' buttons.
```

#### Install Software

`/software/install-distro-packages` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'Install Software', breadcrumb Home > Software > Install Software, favourite star, description 'One-click PHP, Node.js, Python and tool installs, plus any OS package.' Header action: a package-manager pill 'APT (Debian/Ubuntu)'. Body: amber banner 'Reboot required'. Card 'Software' with a 'Refresh package index' button and segmented tabs 'Runtimes', 'Tools', 'Search repositories', 'Installed packages', 'History'. Runtimes shows a banner 'Installed runtimes with updates', then a 'PHP' card with 'Check for updates' and a table 'Version', 'State', 'Updates', 'Packages / note' with 'Install' buttons and pills 'installed · 8.3.6', 'not installed', plus Node.js, Python, Ruby and Go cards. Search has a package box, 'Search' button and a selectable table 'Package', 'Summary', 'Installed' with row menu 'Install', 'Remove', 'Details'. Installed packages lists 'Package', 'Summary', 'Version', 'Arch'.
```

Sub-screens (5):

- **Package details modal**

  ```text
  Modal dialog titled with the package name, showing a key and value list 'Installed', 'Candidate', 'Section / repo', 'Summary' and 'Homepage' as a link, with status pills for installed or not installed, and a single primary 'Close' button.
  ```

- **Remove packages confirmation**

  ```text
  Confirmation dialog 'Remove nginx?' with the text 'Packages that depend on these are removed as well. Configuration files are kept (no purge).' and two buttons, a red 'Remove' and 'Cancel'.
  ```

- **Source build install confirmation**

  ```text
  Confirmation dialog 'Install PHP 8.4?' explaining the version is compiled from the official php.net source into /opt/keel/php/8.4 with its own PHP-FPM service, taking about fifteen minutes, with buttons 'Build and install' and 'Cancel'.
  ```

- **PHP update confirmation**

  ```text
  Confirmation dialog 'Update PHP 8.3 to 8.3.14?' describing that the pending php8.3 packages are upgraded and PHP-FPM reloaded, or the Keel build rebuilt from php.net source, with buttons 'Update' and 'Cancel'.
  ```

- **Remove Node.js version confirmation**

  ```text
  Confirmation dialog 'Remove Node.js 20?' with text about deleting /opt/keel/node/20 and the node20, npm20 and npx20 links in /usr/local/bin, warning that sites started with this Node stop working, buttons red 'Remove' and 'Cancel'.
  ```

#### Module Installers

`/software/module-installers` · catalog

```text
Desktop admin panel screen, 1440px. Page header 'Module Installers', breadcrumb Home > Software > Module Installers, favourite star, description 'PHP, Ruby and Perl module installers.' No header actions. Body: card 'Available installers' subtitled "Each runtime's own package tool, run non-interactively by the agent. Missing tools are regular distro packages." with a dense table 'Runtime', 'Version', 'Installer', 'Install with' and rows 'PHP', 'Perl', 'Ruby', 'Python 3', each showing pills for pecl, pear, cpanm, cpan, gem, pip3, pip and an inline install button when missing. Card 'Install log'. Then four installer cards, 'PHP PECL extensions', 'PHP PEAR packages', 'Ruby gems', 'Python packages (pip)', each with an 'available' or 'not installed' pill, a name field, an optional 'Version (optional)' field, buttons 'Install with pecl' and 'Refresh list', a filter box and a table 'Name', 'Version'. Final card 'Perl modules' links to Install a Perl Module.
```

#### MultiPHP INI Editor

`/software/multiphp-ini-editor` · config

```text
Desktop admin panel screen, 1440px. Page header 'MultiPHP INI Editor', breadcrumb Home > Software > MultiPHP INI Editor, favourite star, description 'php.ini settings per version and domain.' No header actions. Body: card 'Scope' with a select 'Edit' offering 'A PHP version (php.ini, server-wide)' and 'A domain (.user.ini in its document root)', a second select 'PHP version' or 'Domain', and a grey note naming the file path being edited and the other SAPI copies. Card 'Basic mode' subtitled 'Server-wide defaults for this PHP version.' with a segmented control 'Basic' and 'Editor' in its header. Basic shows a two-column grid of directive fields, each labelled with a small 'changed' pill when edited; Editor shows a tall monospace text area. A sticky bar carries a switch 'Reload PHP-FPM after saving', buttons 'Save' and 'Reset', and the text '2 directive(s) changed; empty = remove the directive.'
```

#### PHP Version Manager

`/software/multiphp-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'PHP Version Manager', breadcrumb Home > Software > PHP Version Manager, favourite star, description 'Every PHP version: install, remove, default, and what accounts may pick.' Header actions: 'Check for updates' and 'INI editor'. Body: card 'PHP versions' with a 'Re-detect' button and a wide table 'Version', 'State', 'PHP-FPM', 'Updates', 'Default', 'Domains', 'Offered to accounts' and row buttons 'Install', 'Set as default', 'Remove packages', 'Remove'. Pills read 'Installed', 'Available', 'Not available for this OS', 'system default', 'Security update', 'Up to date'; rows carry advisory badges and a switch 'Offered'. Card 'PHP version job' streams the build log. Card 'PHP version per domain' with a bulk version select, 'Apply to 3 selected', and a searchable table 'Domain', 'Account', 'Type', 'PHP version', 'Change', row menu 'INI'. Card 'PHP-FPM pools' lists 'Version', 'Pool', 'User', 'Listen', 'pm', 'max_children'.
```

Sub-screens (7):

- **Set system default confirmation**

  ```text
  Confirmation dialog 'Make 8.3 the system default?' explaining the default is saved at once and a background job re-pins every inherited domain through the web server, with the CLI alternative updated, buttons 'Set default' and 'Cancel'.
  ```

- **Install version confirmation**

  ```text
  Confirmation dialog 'Install PHP 8.2 (8.2.20)?' listing the packages installed side by side with PHP-FPM and noting the CLI default stays as it is, with buttons 'Install' and 'Cancel'.
  ```

- **Source build confirmation**

  ```text
  Confirmation dialog 'Install PHP 8.5?' saying the version is compiled from the official php.net source into /opt/keel/php/8.5 with its own PHP-FPM service in about fifteen minutes, buttons 'Build and install' and 'Cancel'.
  ```

- **Remove version confirmation**

  ```text
  Confirmation dialog 'Remove PHP 8.1?' with text that every php8.1 package is removed while /etc/php/8.1 is kept, that nothing runs on it, and that the removal is simulated first, buttons red 'Remove' and 'Cancel'.
  ```

- **Forced removal confirmation**

  ```text
  Confirmation dialog 'Remove PHP 8.1 anyway?' listing the extra packages the package manager would also remove, such as roundcube-core and phpmyadmin, warning webmail would stop answering, buttons red 'Remove anyway' and 'Cancel'.
  ```

- **Remove distribution packages confirmation**

  ```text
  Confirmation dialog 'Remove the PHP 8.5 distribution packages?' explaining every php8.5 package goes while the Keel build under /opt/keel/php/8.5 keeps serving the version so no domain moves, buttons red 'Remove' and 'Cancel'.
  ```

- **Update version confirmation**

  ```text
  Confirmation dialog 'Update PHP 8.3 to 8.3.14?' describing either the package upgrade with a PHP-FPM reload or a rebuild from the php.net source and re-render of every domain, buttons 'Update' or 'Build and update' and 'Cancel'.
  ```

#### NGINX Manager

`/software/nginx-manager` · config

```text
Desktop admin panel screen, 1440px. Page header 'NGINX Manager', breadcrumb Home > Software > NGINX Manager, favourite star, description 'NGINX reverse proxy and caching.' Header action: a status pill reading 'proxy active', 'proxy enabled · NGINX down', 'proxy disabled' or 'NGINX not installed'. Body: amber banner 'The rendered proxy config is out of date' with a 'Re-sync now' button, and amber banner 'Apache still listens on all interfaces'. Card 'Install NGINX' when absent, with an 'Install NGINX' button and an 'Install log' card. Card 'Status' with buttons 'Config test', 'Reload', 'Restart', 'View config' and a key and value list covering 'NGINX', 'Managed config', 'Rendered', 'Domains to proxy', 'HTTPS termination', 'Last sync', 'Apache port handling', 'Unknown HTTPS names', 'HTTP/2'. Card 'Reverse proxy' with a switch 'Enable reverse proxy', fields 'Apache backend port (HTTP)', 'Apache backend port (HTTPS)', a switch 'Enable response caching', 'Cache size (MB)', 'Cache TTL for 200/301/302', and buttons 'Save and apply', 'Reset', 'Re-sync domains'.
```

Sub-screens (3):

- **Managed config viewer modal**

  ```text
  Large modal dialog titled with the managed config file path, filled with a scrolling monospace log view of the rendered NGINX configuration, and a single primary 'Close' button in the footer.
  ```

- **Enable proxy confirmation**

  ```text
  Confirmation dialog 'Enable the NGINX reverse proxy?' explaining NGINX takes ports 80 and 443 and forwards to Apache on loopback, the config is validated with nginx -t first, and HTTPS is terminated only for panel-installed certificates, buttons 'Enable proxy' and 'Cancel'.
  ```

- **Disable proxy confirmation**

  ```text
  Confirmation dialog 'Disable the reverse proxy?' saying the managed config is removed, NGINX is stopped and disabled so it releases ports 80 and 443, the stock default site is restored and Apache moves back, buttons red 'Disable' and 'Cancel'.
  ```

#### Rebuild RPM Database

`/software/rebuild-rpm-database` · action

```text
Desktop admin panel screen, 1440px. Page header 'Rebuild RPM Database', breadcrumb Home > Software > Rebuild RPM Database, favourite star, description 'Repair the RPM database.' No header actions. Body: one untitled card holding a key and value list 'Package manager' showing dnf, 'RPM database' with a green 'present' pill, and 'Last rebuild' showing a status pill, a timestamp and the packages counted before and after, or the word 'never'. Below it the grey note 'Use this when rpm or dnf reports a corrupt database (DB_RUNRECOVERY, "rpmdb open failed", stale locks after an interrupted update).' and a primary button 'Rebuild RPM database'. Card 'Rebuild log' appears once a job is running and streams its output. On a Debian host the body is instead a card 'Not applicable on this server'.
```

Sub-screens (2):

- **Rebuild confirmation**

  ```text
  Confirmation dialog 'Rebuild RPM Database' explaining that rpm --rebuilddb rewrites the indexes under /var/lib/rpm from the package headers, runs in the background for several minutes, and that package operations must not run meanwhile, buttons 'Rebuild RPM database' and 'Cancel'.
  ```

- **Non-RPM host state**

  ```text
  Alternate body state: card 'Not applicable on this server' containing a blue information banner 'This is not an RPM-based system' explaining the RPM database exists only on RHEL-family distributions and naming this host's package manager, with a greyed-out 'Rebuild RPM database' button.
  ```

#### System Update

`/software/system-update` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'System Update', breadcrumb Home > Software > System Update, favourite star, description 'Apply operating system updates.' Header action: 'Check now'. Body: amber banner 'Reboot required'. Card 'Pending updates' subtitled with the apt-get dist-upgrade simulation and when it was recorded, with a corner pill reading '14 pending · 3 security' or 'up to date'. Inside, a key and value list 'Last update run', 'Last check', 'Release tier'; four switches 'Full upgrade (dist-upgrade)', 'Remove unused dependencies afterwards', 'Refresh the package index first', 'Apply updates automatically every night'; buttons 'Update everything' and 'Update 3 selected'; and a dense selectable table 'Package', 'Installed', 'Available', 'Repository' where security rows carry a 'security' pill. Card 'Update log' streams the job. Card 'Previous runs' lists 'Job', 'Type', 'Status', 'Started', 'Message' with 'Log' buttons.
```

Sub-screens (1):

- **Apply updates confirmation**

  ```text
  Confirmation dialog 'Apply operating system updates?' saying all pending updates, or the selected packages, are upgraded non-interactively with existing config files kept, and that services restarted by the package manager drop connections briefly, buttons 'Update now' and 'Cancel'.
  ```

#### Update Server Software

`/software/update-server-software` · config

```text
Desktop admin panel screen, 1440px. Page header 'Update Server Software', breadcrumb Home > Software > Update Server Software, favourite star, description 'Update the control panel.' No header actions. Body: card 'Panel version' with a 'Check for updates' button and a key and value list 'Installed version', 'Latest available' with an 'update available' or 'up to date' pill, 'Release tier', 'Last check', 'Install method', 'Published', followed by a 'Release notes' block in a monospace log panel. Card 'How to upgrade to 2.4.0' listing the upgrade commands as a numbered list of monospace steps, a release download link and a grey note that the panel never overwrites its own running code. Card 'Update settings' with fields 'Update feed URL' and a 'Release tier' select offering 'Stable', 'Release', 'Edge (pre-release)', a switch 'Notify when a new version is published', and a 'Save' button.
```

#### EasyApache 4

`/software/easyapache-4` · wizard

```text
Desktop admin panel screen, 1440px. Page header 'EasyApache 4', breadcrumb Home > Software > EasyApache 4, favourite star, description 'Build Apache and PHP profiles.' Header actions: a package-manager pill and 'New profile'. Body: card 'Profiles' with a table 'Profile', 'Description', 'Packages', 'State' and buttons 'Preview', 'Customise' or 'Edit' and 'Delete', rows carrying 'stock' and 'currently provisioned' pills. Card 'Provision "Default"' subtitled 'What changes on this host to match the profile.' with a key and value list 'To install', 'Already installed', 'Managed packages not in profile', 'Removed with them (dependents)', labelled package name lists, a switch to remove packages other profiles manage, an amber banner about dependents and a 'Provision' button. Card 'Build log'. Card 'Currently installed web stack' with a 'Refresh' button and a table 'Package', 'Version', 'Summary'. Card 'Build history'.
```

Sub-screens (3):

- **Profile editor modal**

  ```text
  Large modal dialog 'New profile', 'Customise Default' or 'Edit Custom', with fields 'Name' and 'Description', segmented tabs 'Debian / Ubuntu packages' and 'RHEL family packages', grouped checkbox grids of package names, an 'Additional packages' text area with an 'Add to Debian list' button, a selected-packages line, and footer buttons 'Cancel' and 'Save profile'.
  ```

- **Provision confirmation**

  ```text
  Confirmation dialog 'Provision profile "Default"?' stating how many packages will be installed and removed, naming the dependent packages that also go, and warning Apache and PHP-FPM may restart during the build, with a type-to-confirm field, buttons 'Provision' and 'Cancel'.
  ```

- **Delete profile confirmation**

  ```text
  Confirmation dialog 'Delete profile "Custom"?' with the text 'Installed packages are not touched; only the saved package set is removed.' and two buttons, a red 'Delete' and 'Cancel'.
  ```

### 23. Email

13 screens. Sidebar tile colour for this category is used on its tool cards.

#### Email Deliverability

`/email/email-deliverability` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Email Deliverability', breadcrumb Home > Email > Email Deliverability, favourite star, description 'Checks each domain's SPF, DKIM and DMARC TXT records, MX records and the server's reverse DNS as the rest of the internet sees them, and creates missing records in locally hosted zones with one click.' No header action buttons. Body: one full-width card containing a dense table with a 'Filter domains' search box above it and the columns 'Domain', 'Type', 'Account', 'DNS hosted here' and 'DKIM key'. Domain and account values are monospace; 'DNS hosted here' shows a status pill reading 'yes' or 'no' and 'DKIM key' a pill reading 'generated' or 'none'; an account with no owner shows a dash. Each row ends in a trailing three-dot menu whose single item is 'Check'. Empty state inside the card: 'No domains yet. The domains of hosted accounts are listed here once an account exists.'
```

Sub-screens (3):

- **Deliverability report drill-down**

  ```text
  Drill-down panel above the domain table, card titled 'Deliverability report: example.com', subtitle 'Checked <date> · score 82/100', header buttons 'Re-check' and 'Close'. Inside: a 'Fix all (SPF, DKIM)' button, then a table with columns 'Check', 'Status', 'Current', 'Expected / suggested' and a 'Fix' button column; rows for SPF, DKIM with a selector note, DMARC, MX and PTR. Status pills read ok, warning, missing or unknown, DKIM adds a second pill 'signing on' or 'not signing', and the PTR row says 'Set at your IP provider' instead of a button. A loading state reads 'Resolving SPF, DKIM, DMARC, MX and PTR…'. Footer line: 'Fine-tune the records in Email DNS Record Manager' as a link.
  ```

- **Non-local zone banner**

  ```text
  Informational banner with an info icon inside the deliverability report card, above the checks table, reading 'This domain's DNS is not hosted on this server (no local zone), so records can only be shown, not created. Add them at your DNS provider.' The Fix buttons are absent while it shows.
  ```

- **Create records confirmation**

  ```text
  Confirmation dialog titled 'Create SPF, DKIM record(s)?' with the message 'The panel writes the suggested record(s) into the example.com DNS zone and publishes it. Existing SPF/DMARC records are replaced; DKIM generates a key if none exists.' Two buttons: a primary 'Fix' and a cancel.
  ```

#### Filter Incoming Emails by Country

`/email/filter-incoming-emails-by-country` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Filter Incoming Emails by Country', breadcrumb Home > Email > Filter Incoming Emails by Country, favourite star, description 'Rejects (or exclusively allows) SMTP connections by the sender's country. Countries map to CIDR lists you upload or download (ipdeny.com by default); the lists become Exim host lists in acl_check_rcpt. Authenticated users are never filtered.' Body: a card 'Filtered countries' subtitled 'Default list source: <url> (change mail.country_filter.source_url in Tweak Settings)', its header carrying an 'Applied' status pill with a timestamp and an 'Apply to Exim' button, holding a dense table with columns 'Country', 'Action', 'Enabled', 'Networks', 'Source' and 'Updated'; the action pill reads 'block' or 'allow only', the networks cell is a clickable count or a 'none' pill with 'upload or download a list'. Row menus: 'Download list', 'Disable', 'Switch to allow-only', 'Remove'. Empty state 'No country filters yet. Countries you add below are listed here.' Below, an info or warning banner about the Exim include, then two side-by-side cards: 'Add a country' with 'ISO code', 'Name (optional)' and 'Action' fields and an 'Add country' button, and 'Upload a CIDR list' with 'Country', 'File', 'Or paste networks' and 'Mode' fields and an 'Import' button.
```

Sub-screens (2):

- **CIDR networks modal**

  ```text
  Modal dialog titled 'CIDR networks for RU' containing a single dense paginated table with one column 'Network' listing monospace CIDR ranges, a pager beneath it, and the empty state 'No networks yet. Upload or download a list to see them here.' Closed with the dialog's X control.
  ```

- **Remove country filter confirmation**

  ```text
  Confirmation dialog titled 'Remove the RU filter?' with the message 'Deletes 2457 network(s) and rewrites the Exim lists.' Buttons: a destructive 'Remove' and a cancel.
  ```

#### Filter Incoming Emails by Domain

`/email/filter-incoming-emails-by-domain` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Filter Incoming Emails by Domain', breadcrumb Home > Email > Filter Incoming Emails by Domain, favourite star, description 'Rejects mail whose envelope sender is at a blocked domain (or any of its subdomains) at SMTP time. Allow-listed domains are exempt from the block list and from country filtering of the sender domain. Authenticated users are never filtered.' Body: a card 'Rules' whose header holds an 'Applied' status pill with a timestamp and an 'Apply to Exim' button, containing a dense table with columns 'Sender domain', 'List', 'Enabled', 'Comment' and 'Added'; the sender domain shows the monospace domain followed by a grey '(*@domain, *@*.domain)' hint and the list column a pill reading 'block' or 'allow'. Row menus offer 'Disable' or 'Enable' and a destructive 'Remove'. Empty state: 'No domain rules yet. Domains you add below are listed here.' Then an include-status banner, then two side-by-side cards: 'Add a domain' with 'Domain', 'List' and 'Comment (optional)' fields and an 'Add' button, and 'Rejection message' subtitled 'Sent in the SMTP 550 response to blocked senders' with a 'Message' field and a 'Save message' button.
```

Sub-screens (1):

- **Remove domain confirmation**

  ```text
  Confirmation dialog titled 'Remove spammer.example?' with the message 'The domain leaves the block list and Exim is updated.' Buttons: a destructive 'Remove' and a cancel.
  ```

#### Greylisting

`/email/greylisting` · config

```text
Desktop admin panel screen, 1440px. Page header 'Greylisting', breadcrumb Home > Email > Greylisting, favourite star, description 'Temporarily rejects mail from sender/recipient/host triplets it has never seen; real mail servers retry after a few minutes while most spam engines do not. Runs inside Exim's acl_check_rcpt using Exim's own SQLite lookup or Debian's greylistd.' No header action buttons. Body: a card 'Status' with a key/value list of 'Greylisting' showing an enabled or disabled pill, 'Backend' showing a pill with the backend name plus its database file or socket path, and 'Exim' showing an 'Applied' pill with a timestamp or 'Not applied yet', followed by an include-status banner. Beneath it a segmented control with the tabs 'Settings', 'Trusted (exempt)' with a count badge and 'Records'; the Settings tab shows a card with an 'Enable greylisting' switch and the fields 'Initial deferral (minutes)', 'Must retry within (hours)', 'Records expire after (days)' and 'Deferral message', with 'Save' and 'Reset' buttons.
```

Sub-screens (5):

- **Trusted (exempt) tab**

  ```text
  Segmented-control tab 'Trusted (exempt)' showing a card 'Trusted hosts and domains' subtitled 'Never greylisted' with a dense table of 'Type', 'Value', 'Comment' and 'Added' columns, a destructive 'Remove' row menu item and the empty state 'Nothing is exempt yet. Hosts and domains you add below are listed here.' Below it a card 'Add an exemption' with 'Type', 'Value' and 'Comment (optional)' fields and an 'Add' button.
  ```

- **Records tab**

  ```text
  Segmented-control tab 'Records' showing a card 'Greylist records' subtitled '142 triplet(s) in the Exim SQLite database' with header buttons 'Purge expired' and a destructive 'Delete all'. Inside, a dense table with a 'Filter sender, recipient or host' search box and the columns 'Sender', 'Recipient', 'Host', 'State' with a pill reading 'passed' or 'waiting', 'Attempts', 'First seen' and 'Last seen'.
  ```

- **Enable greylisting confirmation**

  ```text
  Confirmation dialog titled 'Enable greylisting?' with the message 'Unknown senders receive a temporary 451 error and must retry; legitimate mail is delayed by the initial deferral on first contact. Authenticated users and trusted hosts are exempt.' Buttons: a primary 'Enable' and a cancel.
  ```

- **Delete all greylist records confirmation**

  ```text
  Confirmation dialog titled 'Delete every greylist record?' with the message 'Every sender will be greylisted again on its next attempt.' Buttons: a destructive 'Delete all' and a cancel.
  ```

- **Purge expired records confirmation**

  ```text
  Confirmation dialog titled 'Purge expired records?' with the message 'Removes records older than the configured expiry.' Buttons: a primary 'Purge' and a cancel.
  ```

#### Mail Delivery Reports

`/email/mail-delivery-reports` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'Mail Delivery Reports', breadcrumb Home > Email > Mail Delivery Reports, favourite star, description 'Traces each message through the Exim main log: who sent it, which recipients were delivered, deferred or failed, and the remote server's answer.' No header action buttons. Body: a card 'Search' holding a four-field grid of 'Sender' with the hint 'Envelope sender or authenticated user (substring)', 'Recipient', an 'Outcome' picker offering delivered, failed, deferred, queued and completed, and a 'Time window' picker, with a primary 'Search' button and a 'Refresh' button. Below the search, a row of stat tiles reading 'Messages in window', 'Delivery lines' and 'SMTP rejects', a grey note about how far back the current main log reaches, then a card with a dense sortable table: 'Received', 'Sender' with an auth line, 'Recipient', 'Outcome' as a coloured pill, 'Detail' with the transport and remote host beneath, 'Size' and 'Message id'. Empty state: 'No deliveries match in this window.'
```

#### Mail Queue Manager

`/email/mail-queue-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Mail Queue Manager', breadcrumb Home > Email > Mail Queue Manager, favourite star, description 'Messages waiting in the Exim spool (exim -bp). Search by id, sender or recipient, then deliver, freeze, thaw or delete them; flushing runs the whole queue now.' Header action: 'Refresh'. Body: three stat tiles 'In queue', 'Frozen' and 'Matching', then a card 'Queue' subtitled 'Select messages to deliver, freeze, thaw or delete them together.' holding a dense table with row checkboxes, a 'Search id, sender or recipient' box, an 'All messages' picker offering 'Frozen only' and 'Not frozen', and the columns 'Message id', 'Age', 'Size', 'Sender', 'Recipients' and 'State' with a pill reading 'frozen' or 'queued'. Selecting rows reveals a count and the buttons 'Deliver now', 'Freeze', 'Thaw' and a destructive 'Delete'; row menus offer 'View', 'Deliver now', 'Freeze' or 'Thaw' and 'Delete'. Empty state: 'The mail queue is empty. Messages waiting in the spool are listed here.' Last, a card 'Queue-wide actions' with the buttons 'Flush queue (exim -qf)', 'Force flush incl. frozen (exim -qff)', 'Thaw all frozen', 'Delete all frozen' and 'Delete older than 24 h', a streaming progress log beneath them and a monospace output block.
```

Sub-screens (4):

- **Message view modal**

  ```text
  Large modal dialog titled 'Message 1rKvAb-0004Zq-8R'. Inside, a key/value list of 'Subject', 'From' and 'To', then three monospace log blocks under the headings 'Headers (exim -Mvh)', 'Body (exim -Mvb)' which may be marked truncated, and 'Delivery log (exim -Mvl)' falling back to '(no log yet)'. A loading state reads 'Loading…'.
  ```

- **Delete selected messages confirmation**

  ```text
  Confirmation dialog titled 'Delete 8 message(s)?' with the message 'The messages are removed from the Exim spool and will never be delivered. This cannot be undone.' Above the buttons, a text field requiring the word DELETE to be typed when more than five messages are selected. Buttons: a destructive 'Delete' and a cancel.
  ```

- **Bulk delete or thaw confirmation**

  ```text
  Confirmation dialog titled 'Delete matching messages?' or 'Thaw matching messages?', with a message such as 'Deletes every frozen message from the spool.', 'Thaws every frozen message so Exim retries it on the next queue run.' or 'Deletes every message that has been queued for more than 24 hours.' Buttons: 'Delete' or 'Thaw' and a cancel.
  ```

- **Flush queue confirmation**

  ```text
  Confirmation dialog titled 'Flush the queue?' or 'Force-flush the queue?' with the message 'Runs exim -qf in the background: every non-frozen message gets a delivery attempt now.' or the exim -qff wording including frozen messages. Buttons: a primary 'Flush' and a cancel.
  ```

#### Mail Troubleshooter

`/email/mail-troubleshooter` · action

```text
Desktop admin panel screen, 1440px. Page header 'Mail Troubleshooter', breadcrumb Home > Email > Mail Troubleshooter, favourite star, description 'Diagnoses delivery to one address: how Exim would route it (exim -bt), the domain's MX records, whether this server can reach the first exchanger on port 25, and whether a locally hosted domain's MX actually points here.' No header action buttons. Body: a card 'Address to test' with a single 'Email address' field and a primary 'Run diagnostics' button. Results below: a warning banner listing hints, or a success banner reading 'No problems found for someone@example.com.' Then four cards, each with a status pill in its header: 'Domain' pilled 'hosted here' or 'external' over a key/value list of 'Domain', 'Account', 'Email routing' and 'MX points to this server'; 'MX records' pilled with a record count over the exchanger list; 'SMTP connectivity' pilled 'reachable' over 'Host' and 'Banner'; and 'Exim routing (exim -bt)' pilled 'routable', 'unrouteable' or 'Exim not installed' over a route list, a monospace log block and a 'Verification (exim -bv)' sub-section.
```

#### Mailbox Conversion

`/email/mailbox-conversion` · form

```text
Desktop admin panel screen, 1440px. Page header 'Mailbox Conversion', breadcrumb Home > Email > Mailbox Conversion, favourite star, description 'Converts a mailbox between Maildir, mdbox, sdbox and mbox with Dovecot's dsync: doveadm reads the source through mail_location and writes a one-way copy into the target. The source stays untouched; switch the account's mail_location once the copy is verified. Use Dry run first to see the exact command.' No header action buttons. Body: a card 'Account' with a 'Filter' field and an 'Account' picker listing each user with its domain. Once an account is chosen, a card 'Detected mail storage' lists each found path with its format, note and size, or 'No mail directories found under the home directory yet.' Then a card 'Conversion' with the fields 'Source format', 'Source path', 'Target format', 'Target path' and 'Dovecot user (optional)', a 'Dry run' switch, and a primary button reading 'Preview' or 'Start conversion'. A card 'Progress' holds the streaming conversion log.
```

Sub-screens (2):

- **Dovecot missing notice**

  ```text
  Capability notice banner at the top of the page reading 'Dovecot (doveadm) is not installed on this server. Install dovecot-core / dovecot to convert mailboxes.' with a retry control; the 'Start conversion' button below it is disabled.
  ```

- **Convert mailbox confirmation**

  ```text
  Confirmation dialog titled 'Convert alice's mailbox?' explaining that the doveadm sync command reads the source through mail_location and copies it one-way into the target, that the source is left in place, that Dovecot's mail_location must be pointed at the target afterwards, and that large mailboxes take a while. A text field requires the word CONVERT. Buttons: 'Convert' and a cancel.
  ```

#### Repair Mailbox Permissions

`/email/repair-mailbox-permissions` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Repair Mailbox Permissions', breadcrumb Home > Email > Repair Mailbox Permissions, favourite star, description 'Fixes mailbox trees whose ownership or modes were broken by restores, manual copies or scripts: ~/mail and ~/etc become user:user with 0700 directories and 0600 files, which is what Exim and Dovecot expect.' Header action: a primary 'Repair all accounts'. Body: when a repair is running, a card 'Repair progress' holding a streaming log. Below it a card 'Accounts' containing a dense table with row checkboxes, a 'Filter accounts' search box, a toolbar button 'Repair selected (0)' and the columns 'Account', 'Domain', 'Owner', 'Mail tree' showing the monospace home path with /mail appended, and 'State' with an active or suspended pill. Each row's three-dot menu offers 'Repair'. Empty state: 'No accounts yet. Hosted accounts and their mail trees are listed here.'
```

Sub-screens (1):

- **Repair mailboxes confirmation**

  ```text
  Confirmation dialog titled 'Repair 12 mailbox(es)?' with the message 'Each account's ~/mail and ~/etc trees are chowned to the account user and reset to directories 0700 / files 0600. Mail delivery keeps working during the repair.' Buttons: a primary 'Repair' and a cancel.
  ```

#### Spamd Startup Configuration

`/email/spamd-startup-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'Spamd Startup Configuration', breadcrumb Home > Email > Spamd Startup Configuration, favourite star, description 'Options passed to the SpamAssassin daemon at start-up (OPTIONS in /etc/default/spamassassin or SPAMDOPTIONS in /etc/sysconfig/spamassassin). Saving rewrites the file and restarts spamd.' No header action buttons. Body: a card 'Daemon' with a key/value list of 'spamd unit' showing the unit name and an active pill, 'Options file', 'Current OPTIONS' and 'Rules (local.cf)'. Then a card 'Start-up' with the switches 'Start spamd at boot (ENABLED=1)' and 'Nightly rule updates (CRON=1, sa-update)'; a card 'Capacity' with 'Max children', 'Min children', 'Max spare', 'Min spare', 'Max connections per child', 'Scan timeout (s)' and 'Nice level'; a card 'Network' with 'Listen address', 'Port', 'Allowed client IPs' and 'Local tests only (--local)'; and a card 'Users and preferences' with 'Run as user', 'Helper home directory', 'Per-user preferences', 'Allow learning' and 'Syslog facility'. A sticky bar at the bottom holds 'Save and restart spamd' and 'Reset', both disabled until something changes, followed by a card 'Current file' showing the raw options file.
```

Sub-screens (2):

- **SpamAssassin missing notice**

  ```text
  Capability notice banner near the top reading 'SpamAssassin is not installed on this server. Install the spamassassin package to run spamd; the options file below is shown for reference.' with a retry control; the 'Save and restart spamd' button stays disabled.
  ```

- **Disable spamd confirmation**

  ```text
  Confirmation dialog titled 'Disable spamd?' with the message 'SpamAssassin stops scanning incoming mail until it is enabled again.' Buttons: a destructive 'Disable' and a cancel.
  ```

#### View Mail Statistics Summary

`/email/view-mail-statistics-summary` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'View Mail Statistics Summary', breadcrumb Home > Email > View Mail Statistics Summary, favourite star, description 'Mail volume on this server from the Exim main log: messages received, deliveries, failures, deferrals and SMTP-time rejections, by hour and by destination domain.' Header action: 'Refresh'. Body: a narrow card holding a 'Time window' picker offering last hour through last 30 days and whole log. Then a row of stat tiles reading 'Received', 'Delivered', 'Failed', 'Deferred', 'Rejected at SMTP', 'Volume', 'Authenticated' and 'Relaying users', with small coloured dots on the problem ones, and a grey note about how far back the main log reaches. Below, a card 'Volume by hour' with a table of 'Hour', 'Received', 'Delivered', 'Failed', 'Deferred' and a wide horizontal bar column. Then two side-by-side cards: 'Top destination domains' with 'Domain', 'Delivered', 'Failed' and 'Deferred', and 'Top senders' with 'Sender', 'Messages', 'Recipients' and 'Volume'. Last, a card 'Top connecting hosts' as a key/value list of host and message count. Empty rows read 'No mail in this window.'
```

#### View Relayers

`/email/view-relayers` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'View Relayers', breadcrumb Home > Email > View Relayers, favourite star, description 'Who relayed mail through this server after authenticating (SMTP AUTH) or from a local process. A single user with thousands of recipients usually means a compromised mailbox or script.' Header action: 'Refresh'. Body: a row of stat tiles reading 'Relayers', 'Authenticated messages', 'All messages' and 'Failed deliveries', then a grey note about how far back the Exim main log reaches. Below, a card holding a dense sortable table with a 'Filter by user or sender' search box and a time-window picker in its toolbar, and the columns 'Authenticated as' with the mechanism beneath, 'Messages', 'Recipients' bolded past 500, 'Failed', 'Volume', 'First seen', 'Last seen', 'Client hosts' listing up to four with a '+N more' line, and 'Envelope senders' listing up to three; the count columns are right-aligned and a pager sits beneath. Empty state: 'Nobody relayed mail in this window. Authenticated and local senders are listed here.'
```

#### View Sent Summary

`/email/view-sent-summary` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'View Sent Summary', breadcrumb Home > Email > View Sent Summary, favourite star, description 'Outbound mail grouped by sender: authenticated SMTP users, local scripts (user@host) and envelope senders, with how many of their messages were delivered, deferred or bounced.' Header action: 'Refresh'. Body: a row of stat tiles reading 'Messages', 'Delivered', 'Failed', 'Deferred', 'Volume' and 'Authenticated', then a grey note about how far back the Exim main log reaches. Below, a card holding a dense sortable table whose toolbar carries an 'All senders' picker offering 'Authenticated only' and 'Unauthenticated only', a time-window picker and a 'Filter senders' search box. Columns: 'Sender' in monospace followed by an 'authenticated' pill, 'Messages', 'Recipients', 'Delivered', 'Failed' shown bold when non-zero, 'Deferred', 'Volume', 'Last message' and 'From hosts' listing up to three; the count columns are right-aligned with a pager beneath. Empty state: 'No outbound mail in this window. Senders are listed here as mail goes out.'
```

### 24. System Health

4 screens. Sidebar tile colour for this category is used on its tool cards.

#### Background Process Killer

`/system-health/background-process-killer` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Background Process Killer', breadcrumb Home > System Health > Background Process Killer, favourite star, description 'Processes on the disallowed list that run as a non-root user are killed on a schedule and logged here. Root is never touched.' Body: two side-by-side cards. 'Status', with an Enabled or Disabled pill in its corner, lists 'Schedule', 'Next scheduled run', 'Last run', 'Last result', 'Enabled names', 'Kills in the last 24 h', 'Kills logged' and 'Notifications', and carries buttons 'Scan and kill now' in red, 'Dry run' and 'Preview matches'. 'Settings' holds a switch 'Enable the scheduled scan', dropdowns 'Signal' and 'Scope', input 'Exempt users', switch 'Notify the server contact after each run that kills something', number field 'Keep the kill log for (days)', then 'Save' and 'Reset'. Below, full-width cards: 'Disallowed processes' with a table of 'Kill' (switch), 'Process name', 'Description' and 'Source', an add form above it; 'Kill log' with a search box, a result filter and columns 'When', 'PID', 'User', 'Command', 'Matched', 'Signal' and 'Result'; and 'Recent runs'.
```

Sub-screens (7):

- **Processes that match right now card**

  ```text
  Drill-down view: a card 'Processes that match right now', subtitled with how many processes were scanned against how many enabled names and the scope in use, with a 'Refresh' button. Dense table of 'PID', 'User', 'Command', 'Matched', 'CPU %' and 'Running', each row with a red 'Kill' action. Empty state: 'No disallowed processes are running.'
  ```

- **Scan and kill now confirmation**

  ```text
  Confirmation dialog titled 'Run the Background Process Killer now?' with the message that every matching process owned by a non-root user is sent SIGKILL immediately. Buttons 'Kill matches' in red and 'Cancel'.
  ```

- **Kill one process confirmation**

  ```text
  Confirmation dialog titled 'Kill PID 48213?' naming the command and the user that owns it, the pattern it matched, and the signal it receives. Buttons 'Kill' in red and 'Cancel'.
  ```

- **Remove disallowed name confirmation**

  ```text
  Confirmation dialog titled 'Remove "minerd"?' with the message 'Processes with this name will no longer be killed.' Buttons 'Remove' in red and 'Cancel'.
  ```

- **Clear kill log confirmation**

  ```text
  Confirmation dialog titled 'Clear the kill log?' with the message 'Every logged kill is deleted. The audit log keeps its own record.' Buttons 'Clear' in red and 'Cancel'.
  ```

- **Nothing is killed yet banner**

  ```text
  Alternate state: an information banner at the top of the page reading 'Nothing is killed yet.' with the paragraph that the disallowed list ships with every entry unticked and the scheduled scan stays paused until names are ticked below.
  ```

- **procps missing notice**

  ```text
  Alternate state: a capability notice at the top of the page reading that the 'ps' program (procps) is not installed on this server, so processes cannot be scanned or killed, with a retry link; the scan, dry-run and preview buttons are greyed out.
  ```

#### Process Manager

`/system-health/process-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Process Manager', breadcrumb Home > System Health > Process Manager, favourite star, description 'Live process table. Kill sends SIGTERM and Force kill sends SIGKILL; Renice changes the scheduling priority. PID 1 and the panel itself are protected.' No header action buttons. Body: one borderless card whose toolbar holds a dropdown offering 'Sort by CPU', 'Sort by memory', 'Sort by run time' and 'Sort by PID', a text box 'Filter by user', a small dropdown of page sizes 50, 200, 500 and 2000, and a 'Refresh' button. Beneath it a dense table with columns 'PID', 'User', 'CPU %', 'Mem %', 'RSS', 'Running', 'State' and 'Command', the command shown in monospace with its arguments in muted text beside it. Each row carries a '...' menu with 'Kill' in red, 'Force kill (SIGKILL)' in red and 'Renice'.
```

Sub-screens (3):

- **Renice modal**

  ```text
  Small modal dialog titled 'Renice PID 48213' with the command and owning user in a muted line at the top, a number field 'Niceness' with helper text '-20 is the highest priority, 19 the lowest. Only root can lower a value.' and the validation message 'Enter a whole number between -20 and 19.' Right-aligned buttons 'Cancel' and 'Renice'.
  ```

- **Send signal confirmation**

  ```text
  Confirmation dialog titled 'Send SIGTERM to PID 48213?' with the command and the owning user as its message. Buttons 'Send' and 'Cancel'; the SIGKILL variant draws the same dialog in danger style with a red 'Send' button.
  ```

- **procps missing notice**

  ```text
  Alternate state: the whole table is replaced by a capability notice explaining that the required process tools are not installed on this server, with a retry action that re-checks capabilities before reloading the list.
  ```

#### Show Current Disk Usage

`/system-health/show-current-disk-usage` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Show Current Disk Usage', breadcrumb Home > System Health > Show Current Disk Usage, favourite star, description 'Filesystem usage.' Header action: a 'Refresh' button. Body: a card 'Filesystems' holding a table with columns 'Filesystem' in monospace, 'Mount point', 'Size', 'Used' and 'Available' right-aligned, and 'Usage' drawn as a percentage above a meter that turns amber past 75 percent and red past 90. Below, a card 'Accounts', subtitled with how many accounts there are, how much they use in total, when the figures were sampled and the note that usage is measured every 6 hours and can be resampled now, with a small 'Resample now' button in its corner. It holds a dense table with columns 'Account' (a link, with a 'Suspended' pill where relevant), 'Domain', 'Owner', 'Home' in monospace, 'Used', 'Quota' and 'Usage' as a percentage over a meter, or the muted word 'unlimited'. Empty state: 'No accounts yet.'
```

Sub-screens (1):

- **Disk usage resample job card**

  ```text
  Alternate state: a card 'Disk usage resample' appears between the filesystems and accounts cards, with a progress bar and a live scrolling monospace log while usage is measured for every account; the 'Resample now' button shows a loading spinner meanwhile.
  ```

#### Show Current Running Processes

`/system-health/show-current-running-processes` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Show Current Running Processes', breadcrumb Home > System Health > Show Current Running Processes, favourite star, description 'Snapshot of running processes, refreshed every 10 seconds. Use Process Manager to kill or renice.' No header action buttons. Body: one borderless card whose toolbar holds a dropdown offering 'Sort by CPU', 'Sort by memory', 'Sort by run time' and 'Sort by PID', a text box 'Filter by user', a small dropdown of page sizes 50, 200, 500 and 2000, and a 'Refresh' button. Beneath it a dense, read-only table with columns 'PID', 'User', 'CPU %', 'Mem %', 'RSS', 'Running', 'State' and 'Command', the command in monospace with its arguments in muted text beside it. No row action menus anywhere in the table.
```

Sub-screens (1):

- **procps missing notice**

  ```text
  Alternate state: the whole table is replaced by a capability notice explaining that the required process tools are not installed on this server, with a retry action that re-checks capabilities before reloading the snapshot.
  ```

### 25. Panel

6 screens. Sidebar tile colour for this category is used on its tool cards.

#### Change Log

`/cpanel/change-log` · split

```text
Desktop admin panel screen, 1440px. Page header 'Change Log', breadcrumb Home > Panel > Change Log, favourite star, description 'What changed in each release.'. Header actions: 'Refresh'. Body is split: a wide left column of release cards, each titled 'Version 1.4.0' with subtitle 'Released 2026-11-02' and formatted release notes with headings and bullet lists; the card for the running version carries a green 'running' pill, and an 'Unreleased' card subtitled 'Changes not yet in a tagged release' carries an 'upcoming' pill. A narrow right sidebar holds card 'This server' listing 'Running version', 'Release notes' and 'Source' as a file path, and card 'Releases', a list of 'All releases' followed by every version with its date as selectable links. When the file is missing one card shows the empty state 'No release notes on this server'.
```

#### Customization

`/cpanel/customization` · config

```text
Desktop admin panel screen, 1440px. Page header 'Customization', breadcrumb Home > Panel > Customization, favourite star, description 'Branding, logos and help links.'. No header actions. A segmented control 'Branding' and 'Account panel' sits above the body with 'Branding' selected. Body: card 'Company' with 'Company name' (required), 'Tagline' and 'Footer text'; card 'Logo' showing the current image beside rows 'Type', 'Size' and 'Updated', a 'Choose file' control reading 'No file chosen', and 'Upload' and 'Remove' buttons; the same card again for 'Favicon'; card 'Colours' with 'Primary colour' and 'Chrome colour', each a swatch picker beside a '#rrggbb (empty = theme default)' input and 'Clear', plus a small preview of a primary button and a chrome chip; card 'Help and documentation links' with 'Help URL', 'Documentation URL' and 'Support URL'; card 'Login page notice' with a large text area. A sticky bottom bar holds 'Save' and 'Reset'.
```

Sub-screens (6):

- **Remove logo confirmation**

  ```text
  Confirmation dialog 'Remove the logo?' with the message 'The default Keel mark is shown until a new image is uploaded.' and buttons 'Cancel' and a red 'Remove'. The favicon card raises the same dialog titled 'Remove the favicon?'.
  ```

- **Account panel tab**

  ```text
  Drill-down view, 'Account panel' tab selected: card 'Account panel' with a linked 'Account sign-in URL', an 'Availability' switch 'Account panel enabled', a 'Require 2FA for account users' switch, a required 'Log in as window (minutes)' number field and a 'Webmail URL' field, with 'Save' and 'Reset'.
  ```

- **Webmail publish card**

  ```text
  Drill-down view, card 'Webmail' on the Account panel tab: rows 'Status' with a pill such as 'Published' or 'Not published', 'Application', 'Address', 'Apache', 'Answers' and 'Last publish', a 'Single sign-on' sub-section with status rows and two switches, and header buttons 'Publish webmail' and a red 'Unpublish'.
  ```

- **phpMyAdmin single sign-on card**

  ```text
  Drill-down view, card 'phpMyAdmin' on the Account panel tab: rows 'Status' with a pill, 'Address', 'Signon script', 'Drop-in' and 'Hidden users', a muted explanation line, and one switch 'Open phpMyAdmin from the account panel without a password' with a long description beneath it.
  ```

- **Log in as history**

  ```text
  Drill-down view, card 'Log in as history' on the Account panel tab: a dense sortable paged table with columns 'When', 'Admin', 'Account', 'From', 'Ended' and 'Status' showing pills 'Active', 'Expired' and 'Ended'. Empty state 'Nobody has logged in to an account panel yet.'
  ```

- **Unpublish webmail confirmation**

  ```text
  Confirmation dialog 'Unpublish webmail?' saying the webmail URL stops answering and the Keel block is removed from config.inc.php while the application stays installed. Buttons 'Cancel' and a red 'Unpublish'.
  ```

#### Manage Plugins

`/cpanel/manage-plugins` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Plugins', breadcrumb Home > Panel > Manage Plugins, favourite star, description 'Install and enable plugins.'. Header actions: 'Refresh'. Body opens with an information banner 'Plugins run inside the panel process', then a segmented control 'Installed' with a count badge and 'Marketplace'. Card 'Signature policy', subtitle 'Who may ship code into this panel', with a warning banner 'Unsigned packages are accepted' and switches 'Require signed packages' and 'Developer mode (sideloading)'. Card 'Install a plugin' with a 'Package file' chooser reading 'No file chosen' and an 'Or a package path on this server' input, plus 'Install'. Card 'Installed plugins': table of 'Plugin', 'State', 'Package', 'Permissions' and 'Installed', with pills 'Signed', 'Unsigned', 'Bundled', 'Marketplace', 'Sideloaded' and a row '...' menu 'Disable', 'Details', 'Uninstall (keep data)', 'Uninstall and purge'. Empty state 'No plugins installed yet'.
```

Sub-screens (12):

- **Accept unsigned packages confirmation**

  ```text
  Confirmation dialog 'Accept unsigned plugin packages?' warning that anyone with root access to the panel will be able to install packages that no trusted key has verified. Buttons 'Cancel' and a red 'Accept unsigned'.
  ```

- **Turn developer mode on confirmation**

  ```text
  Confirmation dialog 'Turn developer mode on?' explaining unsigned packages can then be sideloaded while the marketplace hub is enabled, and revoked plugins can be re-enabled without acknowledging the revocation. Buttons 'Cancel' and a red 'Turn on'.
  ```

- **Uninstall plugin confirmation**

  ```text
  Confirmation dialog 'Uninstall Notes?' saying the plugin code is removed while its settings, stored data and logs are kept for a later re-install. Buttons 'Cancel' and a red 'Uninstall'.
  ```

- **Uninstall and purge confirmation**

  ```text
  Confirmation dialog 'Uninstall and purge Notes?' saying the plugin code, its settings, stored data, logs and data directory are deleted and this cannot be undone. Buttons 'Cancel' and a red 'Uninstall and purge'.
  ```

- **Plugin details drill-down**

  ```text
  Drill-down view below the table: card 'Notes 1.2.0' with 'Refresh' and 'Close', rows 'Plugin id', 'State', 'Author', 'Package', 'Isolation', 'Host API', 'Installed' and 'Code / data', then sections 'Permissions' (table 'Permission' and 'What it allows'), 'Settings', 'Issue restore token', 'Pages', 'Schedules', 'Recent jobs' and a 'Log' output block.
  ```

- **Issue restore token form**

  ```text
  Drill-down section 'Issue restore token' inside the plugin detail card: fields 'Backup artefact id' and 'Account', a button 'Issue restore token', and after issuing a green banner 'Token' showing the token in monospace with its expiry time.
  ```

- **Marketplace tab**

  ```text
  Drill-down view, 'Marketplace' tab selected: a toolbar with 'Search plugins…', an 'All categories' select, a hub and signing-key summary line, 'Check for updates' and 'Refresh'; below, a grid of plugin cards showing name, developer with a verified mark, summary, price, version, install count and rating, plus 'Details', 'Install' and 'Uninstall'. Empty state 'No plugins match'.
  ```

- **Install from marketplace modal**

  ```text
  Modal dialog 'Install Sample Notes' with the summary, rows 'Developer', 'Price', 'Requires host API' and 'Signed by', a section 'Permissions requested' listing each scope with its explanation and the developer's justification, and the trust banner. Footer 'Cancel' and 'Install v1.2.0'.
  ```

- **Permission consent modal**

  ```text
  Modal dialog 'Sample Notes 1.3.0: permissions' saying the package was installed and verified but is held disabled until the permissions are granted, with the permission table marking new scopes and the trust banner below. Footer 'Keep disabled' and 'Grant and enable'.
  ```

- **Marketplace plugin detail drill-down**

  ```text
  Drill-down view: card 'Sample Notes v1.2.0' with 'Refresh' and 'Close', rows 'Plugin id', 'Developer', 'Category', 'Price', 'Compatibility', 'Installed', 'Rating' and 'Links', action buttons 'Install', 'Uninstall (keep data)' and 'Uninstall and purge', then sections 'Permissions', 'Versions' table, 'Changelog', 'Reviews' and 'Write a review'.
  ```

- **Marketplace uninstall confirmation**

  ```text
  Confirmation dialog raised from the Marketplace tab, 'Uninstall and purge Sample Notes?', with the same wording about deleting settings, stored data, logs and data directory irreversibly, and buttons 'Cancel' and a red 'Uninstall and purge'.
  ```

- **Install progress card**

  ```text
  Drill-down view above the catalog: card 'Install Sample Notes' with a 'Dismiss' button and a streaming progress log of the install job, lines appearing as the package is downloaded, verified and unpacked.
  ```

#### Modify Panel News

`/cpanel/modify-cpanel-and-whm-news` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Modify Panel News', breadcrumb Home > Panel > Modify Panel News, favourite star, description 'News shown to users.'. Header actions: 'New item'. Body: one card 'News items' whose subtitle explains items are shown at the top of the Home dashboard for the chosen audience while enabled and inside the time window, and that users can dismiss information and warnings while critical items stay until hidden. A status select 'All statuses' sits in the card's top right and a 'Search title or body' box above the table. Table columns: 'Title' (bold title above a truncated body line), 'Status' pill ('active', 'scheduled', 'expired', 'disabled'), 'Audience', 'Severity' pill ('info', 'warning', 'critical'), 'Window' reading 'now → open', and 'Updated' with the author. Row '...' menu: 'Edit', 'Hide', 'Delete'. Empty state 'Nothing published yet'.
```

Sub-screens (3):

- **New or edit news item**

  ```text
  Modal dialog 'New news item', titled 'Edit "Maintenance window"' when editing: fields 'Title' (required), 'Body' as a large Markdown text area, then 'Audience', 'Severity', 'Show from' and 'Show until' date-and-time inputs in two columns, and an 'Enabled' switch described as 'Disabled items are kept but never shown.'. Footer 'Cancel', 'Preview', 'Publish'.
  ```

- **News item preview**

  ```text
  Modal dialog in preview mode: the same dialog body replaced by the rendered announcement as users will see it, a coloured banner with a megaphone icon, the item title in bold and its formatted Markdown text. Footer buttons 'Cancel', 'Edit' and 'Publish'.
  ```

- **Delete news item confirmation**

  ```text
  Confirmation dialog 'Delete "Maintenance window"?' with the message 'The item disappears from every dashboard immediately.' and buttons 'Cancel' and a red 'Delete'.
  ```

#### Reset a Mailman Password

`/cpanel/reset-a-mailman-password` · form

```text
Desktop admin panel screen, 1440px. Page header 'Reset a Mailman Password', breadcrumb Home > Panel > Reset a Mailman Password, favourite star, description 'Mailing list admin password.'. Header actions: 'Refresh'. Body: card 'Mailing lists', subtitle 'Every Mailman 2 list on this server, advertised or not', with a table of 'List' (monospace) and 'Description' and a row action 'Reset password'; empty state 'No mailing lists yet'. Card 'Reset a list administrator password', subtitle 'Runs Mailman's change_pw for the selected list', with a narrow form: required 'Mailing list' with autocomplete from the table and required 'New administrator password' with a strength meter, then 'Reset password'. Card 'Site password' with 'New password', a switch 'Set the list-creator password instead of the site password' and 'Set password'. Card 'About' listing 'Mailman flavour', 'Lists' and 'Audit'. When Mailman is missing an install notice replaces the cards.
```

Sub-screens (1):

- **Reset list password confirmation**

  ```text
  Confirmation dialog 'Reset the administrator password of "announce"?' saying the current list administrator password stops working immediately and the new one should be handed to the list owner over a secure channel. Buttons 'Cancel' and a red 'Reset password'.
  ```

#### Upgrade to Latest Version

`/cpanel/upgrade-to-latest-version` · action

```text
Desktop admin panel screen, 1440px. Page header 'Upgrade to Latest Version', breadcrumb Home > Panel > Upgrade to Latest Version, favourite star, description 'Upgrade the panel.'. Header actions: 'Refresh'. Body: card 'Version' with a 'Check for updates' button and rows 'Running', 'Latest' carrying an 'update available' or 'up to date' pill, 'Release feed' and 'Last check', then formatted release notes. Card 'Upgrade to 1.5.0', subtitle 'Download, verify, unpack and run the installer', with rows 'Archive', 'SHA-256', 'Signature' and 'Host policy', each carrying a pill, a warning banner when the release cannot be verified, an acknowledgement switch and a red 'Download and upgrade' button. Card 'Trusted release-signing keys' with a table 'Key id', 'Fingerprint', 'Added' and a 'Remove' button, plus a form 'Key id' and 'Public key (PEM)' with 'Trust key'. Card 'Manual upgrade' with a numbered list of commands.
```

Sub-screens (5):

- **Start upgrade confirmation**

  ```text
  Confirmation dialog 'Upgrade to 1.5.0?' explaining the release is downloaded and verified, then the installer runs as a detached unit, redeploying the code, rebuilding the interface and restarting the services, and that the panel is unavailable for a minute. A filled input asks the operator to type UPGRADE. Buttons 'Cancel' and a red 'Start upgrade'.
  ```

- **Remove trusted key confirmation**

  ```text
  Confirmation dialog 'Stop trusting key "release-2026"?' with the message 'Releases signed with it will no longer verify.' and buttons 'Cancel' and a red 'Remove'.
  ```

- **Upgrade progress**

  ```text
  Drill-down view: card 'Upgrade progress', subtitle saying the installer's output is streamed until the panel restarts, holding a dark monospace log block that fills line by line with download, verify, unpack and install steps.
  ```

- **Last upgrade result**

  ```text
  Drill-down view: card 'Last upgrade' with a status pill 'succeeded' in its top right and rows 'Version' reading '1.4.0 → 1.5.0', 'Started', 'Finished', 'Installer exit status', 'Signed by', 'Unit' and 'Log file', followed by a monospace log block.
  ```

- **Host-managed keys state**

  ```text
  Drill-down view of card 'Trusted release-signing keys' when keys are managed on the host: the add form is replaced by a muted paragraph explaining that key files are dropped into the agent's key directory as root, and the table's remove buttons are gone.
  ```

### 26. SSL/TLS

7 screens. Sidebar tile colour for this category is used on its tool cards.

#### Generate an SSL Certificate and Signing Request

`/ssl-tls/generate-an-ssl-certificate-and-signing-request` · form

```text
Desktop admin panel screen, 1440px. Page header 'Generate an SSL Certificate and Signing Request', breadcrumb Home > SSL/TLS > Generate an SSL Certificate and Signing Request, favourite star, description 'Create a key and CSR.' No header actions. Body: two cards side by side. 'Certificate details', subtitle saying the key and CSR are stored encrypted in the SSL Storage Manager, holds radio buttons 'What to generate' offering 'Private key + signing request (CSR)' and 'Self-signed certificate' with a line of explanation each, then 'Account', required 'Domain (common name)', a monospace 'Additional names (SANs)' text area, 'Valid for (days)' number box, 'Key type' and 'Key size'. 'Subject' holds 'Organization (O)', 'Organizational unit (OU)', 'City (L)', 'State / province (ST)', 'Country (C)' and 'Contact email'. A sticky bar carries 'Generate key + CSR'. Below, card 'Recent signing requests' with a compact table 'Domain', 'Account', 'Subject', 'Key', 'Created' and row menus 'Download CSR' and 'Download key'.
```

Sub-screens (1):

- **Generated result card**

  ```text
  Same screen after generating: a card 'Generated for example.com' warning that the private key is shown once, a certificate summary list ('Common name', 'Alternative names', 'Issuer', 'Valid from', 'Expires', 'Key', 'Signature', 'SHA-256 fingerprint'), and read-only monospace blocks 'Private key' and 'Certificate signing request', each with 'Copy' and 'Download' buttons.
  ```

#### Install an SSL Certificate on a Domain

`/ssl-tls/install-an-ssl-certificate-on-a-domain` · form

```text
Desktop admin panel screen, 1440px. Page header 'Install an SSL Certificate on a Domain', breadcrumb Home > SSL/TLS > Install an SSL Certificate on a Domain, favourite star, description 'Deploy a certificate.' No header actions. Body: two cards side by side. 'Domain' holds a required 'Install on' picker, a key and value list 'Current certificate' with an installed pill and issuer plus 'Expires' with a days-remaining pill, a 'Use a stored certificate' dropdown listing entries like '#12 example.com · Let's Encrypt · expires 2026-02-14', a switch 'Install even if the certificate does not cover this domain or has expired', and buttons 'Install' and 'Manage SSL hosts'. 'Or paste the certificate' holds monospace text areas 'Certificate (PEM)', 'Private key (PEM)' and 'CA bundle / chain (PEM)'. Below, card 'Certificate preview' with a certificate summary, and card 'Result' listing 'Status', 'Files' and 'Web server'.
```

#### Manage AutoSSL

`/ssl-tls/manage-autossl` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Manage AutoSSL', breadcrumb Home > SSL/TLS > Manage AutoSSL, favourite star, description 'Automatic certificate issuance and renewal.' Header action: filled 'Run AutoSSL now'. Body: a row of five stat tiles 'Domains', 'Secured', 'Via AutoSSL', 'Expiring soon', 'Excluded'. Under them a segmented control 'Providers', 'Options', 'Manage domains', 'Exclusions', 'Runs and log' with count badges. The 'Providers' panel shows card 'Provider' subtitled with the installed ACME clients, radio buttons 'ACME client' offering 'Disabled', 'Let's Encrypt via certbot' and 'Let's Encrypt via acme.sh' each with a line of explanation, an 'Account email' box, a key and value list 'Daily schedule' and 'Last run' with status pills, and a 'Save' button.
```

Sub-screens (6):

- **Options tab**

  ```text
  Same screen with the 'Options' tab selected, showing card 'Issuance options' with dropdowns 'Validation method' and 'Key type', a number box 'Renew when fewer than (days) remain', and switches 'Also cover www.<domain>', 'Replace manually installed certificates' and 'Use the staging CA', then 'Save'.
  ```

- **Manage domains tab**

  ```text
  Same screen with the 'Manage domains' tab selected: card 'Domains' with a compact table 'Domain', 'Account', 'Type', 'Certificate', 'Expires', 'Next pass' whose last column shows pills reading 'issue', 'renew', 'valid', 'skip: excluded' or 'skip: suspended'; row menu 'Run for this domain' and 'Exclude'.
  ```

- **Exclusions tab**

  ```text
  Same screen with the 'Exclusions' tab selected: card 'Excluded accounts and domains' with a table 'Kind', 'Value', 'Reason', 'Since' and a row action 'Include again', beside card 'Add an exclusion' with 'Kind' dropdown, a 'Domain' or 'Username' box, a 'Reason' box and an 'Exclude' button.
  ```

- **Runs and log tab**

  ```text
  Same screen with the 'Runs and log' tab selected: card 'Run now' with a 'Limit to one domain (optional)' dropdown, buttons 'Run' and a red 'Force renewal', and a streaming log panel; below, card 'Previous runs' with a table 'Started', 'Trigger', 'Provider', 'Status', 'Result' and a 'Details' row action.
  ```

- **Run details drill-down**

  ```text
  Expanded detail table under a selected run row, with columns 'Domain', 'Account', 'Action' showing pills such as issued, skip or failed, and 'Message' carrying the muted explanation from the ACME client.
  ```

- **Force renewal confirmation**

  ```text
  Confirmation dialog titled 'Force renewal?' with the message that every eligible certificate is re-issued even if it is far from expiry and that Let's Encrypt rate-limits duplicate certificates at five per week per name set, and the buttons 'Force run' in red and 'Cancel'.
  ```

#### Manage SSL Hosts

`/ssl-tls/manage-ssl-hosts` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage SSL Hosts', breadcrumb Home > SSL/TLS > Manage SSL Hosts, favourite star, description 'Installed certificates and expiry.' Header action: filled 'Install a certificate'. Body: one card 'Installed certificates', subtitle 'Bundles live under /etc/ssl/whm/<domain>/. Vhost changes are applied by the web server category.' A toolbar carries a search box 'Filter by domain or account' and a segmented control 'All', 'Expiring ≤ 30d', 'AutoSSL', 'Pending / unmanaged' with counts. The compact table has columns 'Domain' (monospace), 'Account', 'Issuer' (a 'self-signed' pill where relevant), 'Expires' (a pill such as '18d · 25 Nov' or 'expired 4d ago'), 'Source' ('AutoSSL' or 'manual'), 'State' ('installed', 'files written · vhost pending', 'stored', 'files only (not in panel)') and 'Files' ('on disk' or 'missing on disk'); row menu 'Details' and a red 'Uninstall'. Empty state: 'Installed certificates appear here. Install one or enable AutoSSL.'
```

Sub-screens (2):

- **Certificate details modal**

  ```text
  Large modal dialog titled 'Certificate on example.com' with a muted line giving the bundle path, then a certificate summary listing 'Common name', 'Alternative names', 'Issuer', 'Valid from', 'Expires', 'Key', 'Signature', 'SHA-256 fingerprint' and 'Chain verification', and a single 'Close' button.
  ```

- **Uninstall confirmation**

  ```text
  Confirmation dialog titled 'Remove the certificate from example.com?' explaining that the certificate files under /etc/ssl/whm are deleted and the vhost falls back to the server default certificate while the certificate stays in the SSL Storage Manager; buttons 'Uninstall' in red and 'Cancel'.
  ```

#### Purchase and Install an SSL Certificate

`/ssl-tls/purchase-and-install-an-ssl-certificate` · catalog

```text
Desktop admin panel screen, 1440px. Page header 'Purchase and Install an SSL Certificate', breadcrumb Home > SSL/TLS > Purchase and Install an SSL Certificate, favourite star, description 'Buy a certificate from a provider.' No header actions. Body: card 'Providers' with a corner link 'Market Provider Manager' and a compact table 'Provider', 'Status' (enabled or disabled pill), 'Products' (names with price and term) and 'Site'. Under it a blue banner 'No provider is enabled' when none are. Then two cards side by side: 'Order a certificate' with 'Provider', 'Product' and required 'Domain' pickers, and 'Organization (for OV/EV products)' with 'Organization (O)', 'Organizational unit (OU)', 'City (L)', 'State / province (ST)', 'Country (C)', 'Contact email' and the button 'Record order and generate CSR'. Last, card 'Orders' with a table '#', 'Domain', 'Account', 'Provider', 'Product', 'Price', 'Status', 'Placed' and row menu 'Install certificate', 'Show CSR', 'Cancel'.
```

Sub-screens (3):

- **Placed order card**

  ```text
  Card titled 'Order #14: example.com' listing 'Provider', 'Product', 'Price' and 'Status' as a pill, a read-only monospace block 'Certificate signing request (submit this to the provider)' with Copy and Download buttons, and the button 'I have the certificate: install it'.
  ```

- **Install issued certificate modal**

  ```text
  Large modal dialog titled 'Install the issued certificate for example.com', noting the private key generated with the order is used automatically, with monospace text areas 'Certificate (PEM)' and 'CA bundle (PEM)', a text box 'Provider order reference', and the buttons 'Later' and 'Install'.
  ```

- **Cancel order confirmation**

  ```text
  Confirmation dialog titled 'Cancel order #14?' with the message 'The generated CSR and key stay in the SSL Storage Manager.' and the buttons 'Cancel order' in red and 'Cancel'.
  ```

#### SSL Storage Manager

`/ssl-tls/ssl-storage-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'SSL Storage Manager', breadcrumb Home > SSL/TLS > SSL Storage Manager, favourite star, description 'Stored keys, CSRs and certificates.' Header actions: filled 'Upload' and 'Generate'. Body: one card 'Stored items', subtitle 'Keys are encrypted at rest with the panel master key; viewing or downloading a key is audited.' Its toolbar holds a segmented control 'All', 'Keys', 'CSRs', 'Certificates' with counts and an account dropdown set to 'All accounts'. The compact table has columns 'Type' (pills 'Private key', 'Signing request', 'Certificate'), 'Domain' (monospace), 'Account' (muted 'server' when none), 'Subject / issuer', 'Expires' (a days-remaining pill), 'State' and 'Created'; row menu 'View', 'Download', 'Install' and a red 'Delete'. Empty state: 'Stored keys, signing requests and certificates appear here. Generate a CSR or upload a certificate to start.'
```

Sub-screens (4):

- **View item modal**

  ```text
  Large modal dialog titled 'Certificate: example.com' showing a certificate summary list with common name, alternative names, issuer, validity, key, signature, fingerprint and chain verification, then a read-only monospace 'PEM' block with Copy and Download buttons, and a 'Close' button.
  ```

- **Upload to SSL storage modal**

  ```text
  Large modal dialog titled 'Upload to SSL storage' explaining any combination may be pasted, with an 'Account' dropdown, a 'Domain' picker, and monospace text areas 'Certificate', 'Private key', 'CA bundle' and 'CSR'; buttons 'Cancel' and 'Store'.
  ```

- **Show private key confirmation**

  ```text
  Confirmation dialog titled 'Show the private key?' with the message 'Anyone who sees this key can impersonate the site. The export is recorded in the audit log.' and the buttons 'Show key' and 'Cancel'.
  ```

- **Delete stored item confirmation**

  ```text
  Confirmation dialog titled 'Delete this private key for example.com?' warning that without the private key the matching certificate can no longer be installed anywhere and that this cannot be undone, with a box asking the reader to type 'example.com', and the buttons 'Delete' in red and 'Cancel'.
  ```

#### SSL/TLS Configuration

`/ssl-tls/ssl-tls-configuration` · config

```text
Desktop admin panel screen, 1440px. Page header 'SSL/TLS Configuration', breadcrumb Home > SSL/TLS > SSL/TLS Configuration, favourite star, description 'Protocols, ciphers and HSTS.' No header actions. Body: two columns. Left, card 'Profile' subtitled 'Mozilla-style presets. Switching a protocol or cipher turns the profile into Custom.', with radio buttons 'Preset' ending in 'Custom', a 'Protocols' block of four switches 'TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3' over an amber banner 'TLS 1.0 and 1.1 are deprecated (RFC 8996) and fail PCI-DSS scans', monospace areas 'Cipher list (TLS ≤ 1.2)' and 'TLS 1.3 cipher suites', and a switch 'Prefer the server's cipher order'. Right, card 'HTTP Strict Transport Security' with switches 'Enable HSTS', 'includeSubDomains', 'preload' and a 'max-age (seconds)' number box, then card 'Apply to' with switches 'Apache (all SSL vhosts)', 'Exim (SMTP)', 'Dovecot (IMAP/POP3)'. A bottom bar carries 'Save and apply', 'Save only' and 'Reset'.
```

Sub-screens (2):

- **Apply result panel**

  ```text
  Result block under the action bar listing each service against pills such as 'validated', 'via Service Configuration', 'apache2 reloaded' or a pending note, with the managed include path in monospace and a collapsed row 'Current managed include for apache' that expands into a log-style preformatted block.
  ```

- **TLS 1.3 only confirmation**

  ```text
  Confirmation dialog titled 'TLS 1.3 only?' with the message 'Clients older than 2019 (and many mail apps) will no longer connect to websites, SMTP, IMAP or POP3 on this server.' and the buttons 'Apply' and 'Cancel'.
  ```

### 27. Market

1 screens. Sidebar tile colour for this category is used on its tool cards.

#### Market Provider Manager

`/market/market-provider-manager` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Market Provider Manager', breadcrumb Home > Market > Market Provider Manager, favourite star, description 'Enable marketplace providers.' Header action: 'Add provider'. Body: card 'Overview' subtitled 'Providers supply certificates for Purchase and Install an SSL Certificate and plugins for the Marketplace. ACME clients are reflected from Manage AutoSSL.' with a key and value list 'SSL providers', 'Plugin providers', 'Needing configuration', 'AutoSSL'. A green or red result banner reads 'Sectigo: Test passed'. Card 'Providers' holds a dense table 'Provider', 'Type', 'Status', 'Products (resale)', 'Commission', 'Orders', 'Last test', each row showing the display name, identifier, adapter label and site link, status pills 'Enabled', 'Disabled', 'Needs configuration', 'AutoSSL provider', and a row menu 'Enable', 'Configure', 'Test', 'Edit', 'Sync products', 'Delete'. Empty state: 'No providers yet. Providers you add appear here next to the built-in marketplace hub and the ACME clients.'
```

Sub-screens (3):

- **Add or edit provider modal**

  ```text
  Large modal dialog 'Add a provider' or 'Edit Sectigo' with fields 'Identifier', 'Display name', 'Type', 'Adapter', 'Vendor URL' and 'Commission (%)', then a 'Products' table of 'ID', 'Name', 'Vendor price', 'Currency', 'Months', 'Wildcard', 'Resale' with an 'Add product' button; footer 'Cancel' and 'Add provider'.
  ```

- **Configure provider modal**

  ```text
  Modal dialog 'Configure Sectigo' noting credentials are stored encrypted and never shown again, with a 'Vendor URL' field and adapter credential fields, each secret one a password box placeholdered 'Stored; leave blank to keep' beside a 'Clear' switch; footer 'Cancel' and 'Save'.
  ```

- **Delete provider confirmation**

  ```text
  Confirmation dialog 'Delete Sectigo?' saying orders already recorded against the provider keep their history while new orders can no longer be placed with it, with a type-to-confirm field for the identifier, buttons red 'Delete provider' and 'Cancel'.
  ```

### 28. Restart Services

8 screens. Sidebar tile colour for this category is used on its tool cards.

#### Database Server

`/restart-services/database-server` · action

```text
Desktop admin panel screen, 1440px. Page header 'Database Server', breadcrumb Home > Restart Services > Database Server, favourite star, description 'Restart MySQL/MariaDB.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart Database Server'. When the daemon is absent the button is greyed out with the note that it is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area; a failure shows an error banner instead.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'Database Server' asking 'Restart Database Server now? Active connections will be dropped briefly.' Buttons: a primary 'Restart Database Server' and Cancel.
  ```

#### DNS Server

`/restart-services/dns-server` · action

```text
Desktop admin panel screen, 1440px. Page header 'DNS Server', breadcrumb Home > Restart Services > DNS Server, favourite star, description 'Restart BIND.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart DNS Server'. When BIND is absent the button is greyed out with the note that it is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area; a failure shows an error banner instead.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'DNS Server' asking 'Restart DNS Server now? Active connections will be dropped briefly.' Buttons: a primary 'Restart DNS Server' and Cancel.
  ```

#### HTTP Server (Apache)

`/restart-services/http-server-apache` · action

```text
Desktop admin panel screen, 1440px. Page header 'HTTP Server (Apache)', breadcrumb Home > Restart Services > HTTP Server (Apache), favourite star, description 'Restart Apache.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart HTTP Server (Apache)'. When Apache is absent the button is greyed out with the note that it is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area; a failure shows an error banner instead.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'HTTP Server (Apache)' asking 'Restart HTTP Server (Apache) now? Active connections will be dropped briefly.' Buttons: a primary 'Restart HTTP Server (Apache)' and Cancel.
  ```

#### IMAP Server

`/restart-services/imap-server` · action

```text
Desktop admin panel screen, 1440px. Page header 'IMAP Server', breadcrumb Home > Restart Services > IMAP Server, favourite star, description 'Restart Dovecot.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart IMAP Server'. When Dovecot is absent the button is greyed out with the note that it is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area; a failure shows an error banner instead.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'IMAP Server' asking 'Restart IMAP Server now? Active connections will be dropped briefly.' Buttons: a primary 'Restart IMAP Server' and Cancel.
  ```

#### Mail Server (Exim)

`/restart-services/mail-server-exim` · action

```text
Desktop admin panel screen, 1440px. Page header 'Mail Server (Exim)', breadcrumb Home > Restart Services > Mail Server (Exim), favourite star, description 'Restart Exim.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart Mail Server (Exim)'. When Exim is absent the button is greyed out with the note that it is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area; a failure shows an error banner instead.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'Mail Server (Exim)' asking 'Restart Mail Server (Exim) now? Active connections will be dropped briefly.' Buttons: a primary 'Restart Mail Server (Exim)' and Cancel.
  ```

#### Mailing List Manager (Mailman)

`/restart-services/mailing-list-manager-mailman` · action

```text
Desktop admin panel screen, 1440px. Page header 'Mailing List Manager (Mailman)', breadcrumb Home > Restart Services > Mailing List Manager (Mailman), favourite star, description 'Restart Mailman.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart Mailing List Manager (Mailman)', most often greyed out with the note that Mailman is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'Mailing List Manager (Mailman)' asking 'Restart Mailing List Manager (Mailman) now? Active connections will be dropped briefly.' Buttons: a primary restart button and Cancel.
  ```

#### PHP-FPM service for Apache

`/restart-services/php-fpm-service-for-apache` · action

```text
Desktop admin panel screen, 1440px. Page header 'PHP-FPM service for Apache', breadcrumb Home > Restart Services > PHP-FPM service for Apache, favourite star, description 'Restart PHP-FPM.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart PHP-FPM service for Apache'. When no pool manager is installed the button is greyed out with the note that it is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'PHP-FPM service for Apache' asking 'Restart PHP-FPM service for Apache now? Active connections will be dropped briefly.' Buttons: a primary restart button and Cancel.
  ```

#### SSH Server (OpenSSH)

`/restart-services/ssh-server-openssh` · action

```text
Desktop admin panel screen, 1440px. Page header 'SSH Server (OpenSSH)', breadcrumb Home > Restart Services > SSH Server (OpenSSH), favourite star, description 'Restart the SSH daemon.' No header actions. Body: a single card beginning with a key-value status block reading 'Unit' with the systemd unit in monospace, 'State' as a pill showing 'Up', 'Down' or 'Not installed', then 'PID', 'Memory' and 'Started'. Below it a primary button 'Restart SSH Server (OpenSSH)'. When the daemon is absent the button is greyed out with the note that it is not installed on this server, linking to Install Software and Service Manager. After a run a result block lists 'Result' as a green 'restarted' pill, 'State now', 'PID' and an 'Output' log area; a failure shows an error banner instead.
```

Sub-screens (1):

- **Restart confirmation**

  ```text
  Confirmation dialog 'SSH Server (OpenSSH)' asking 'Restart SSH Server (OpenSSH) now? Active connections will be dropped briefly.' Buttons: a primary 'Restart SSH Server (OpenSSH)' and Cancel.
  ```

### 29. Development

8 screens. Sidebar tile colour for this category is used on its tool cards.

#### OpenAPI Documentation for the Account Panel

`/development/openapi-documentation-for-cpanel` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'OpenAPI Documentation for the Account Panel', breadcrumb Home > Development > OpenAPI Documentation for the Account Panel, favourite star, description 'The account-scoped subset of the API: what a reseller or an account user may call for the accounts they own.'. No header actions. Body: an info banner 'How this differs from the admin reference' explaining that root-only endpoints are filtered out and ownership is re-checked inside the service, linking to the admin reference. Then a row of stat tiles 'Endpoints' with a '<n> shown · <n> groups' hint plus one tile per method GET, POST, PUT, PATCH, DELETE. Card 'Endpoints', subtitle 'Generated live from the mounted Express routers: every path, method and the role it requires. Pick one to expand a curl example under it.', with buttons 'openapi.json' and 'Refresh', a toolbar of a 'Filter by path…' box and 'All methods' and 'All roles' dropdowns, and collapsible group rows showing '/api/<prefix>' with an endpoint count and role breakdown. Loading state 'Walking the router…'; empty filter state 'No endpoints match this filter. Clear it to see every group again.'
```

Sub-screens (1):

- **Expanded endpoint detail**

  ```text
  Drill-down row expanded inside the endpoints table: method pill, path, role pill, then a key/value list of 'Access', 'Authentication', 'Path parameters' and 'Envelope', a 'curl example' heading with a 'Copy curl' button, a monospace curl block, and a note about creating a token and following 202 job ids.
  ```

#### OpenAPI Documentation for the Admin Panel

`/development/openapi-documentation-for-whm` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'OpenAPI Documentation for the Admin Panel', breadcrumb Home > Development > OpenAPI Documentation for the Admin Panel, favourite star, description 'Every endpoint this panel mounts, generated from the live router: server administration, account functions and the Development API. Root-only routes configure the server; reseller routes are limited to owned accounts inside the service layer.'. No header actions. Body: a row of stat tiles, 'Endpoints' with a '<n> shown · <n> groups' hint and one tile per method GET, POST, PUT, PATCH, DELETE. Card 'Endpoints', subtitle 'Generated live from the mounted Express routers: every path, method and the role it requires. Pick one to expand a curl example under it.', with header buttons 'openapi.json' and 'Refresh', a toolbar holding a 'Filter by path…' input and 'All methods' and 'All roles' dropdowns, then collapsible group headers reading '/api/<prefix>' with '<n> endpoints · <n> root · <n> reseller · <n> public', each opening a table of method pill, path and role pill rows. Loading state 'Walking the router…'.
```

Sub-screens (1):

- **Expanded endpoint detail**

  ```text
  Drill-down row expanded under a selected endpoint: key/value list of 'Access', 'Authentication', 'Path parameters' and 'Envelope', a 'curl example' heading with a 'Copy curl' button and a monospace curl block, plus a note linking to 'Manage API Tokens'.
  ```

#### Apps Managed by AppConfig

`/development/apps-managed-by-appconfig` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Apps Managed by AppConfig', breadcrumb Home > Development > Apps Managed by AppConfig, favourite star, description 'Registered integration apps.'. Header actions: 'Import .conf' and a primary 'Register app'. Body: card 'Registered applications', subtitle 'Third-party and custom apps that appear in the admin panel, the account panel or webmail. ACLs decide which resellers see an admin-panel app; account-panel apps can be gated by feature-list keys.', holding a table of 'App', 'Service', 'URL', 'Requires', 'Visible', 'State' with inline row buttons 'Edit', 'Disable', 'Export' and 'Unregister'. Pills show the service name and enabled or disabled. Empty state 'No apps registered. Register a billing portal, monitoring dashboard or any internal tool to link it from the panel.' Second card 'Launchable by you' as a grid of app tiles showing the display name, service and URL, with the fallback line 'Apps you can open appear here once one is registered, enabled and shown in menus.'
```

Sub-screens (3):

- **Register or edit application**

  ```text
  Modal dialog 'Register application' (or 'Edit <app>'), wide. Two-column fields 'Identifier', 'Display name', 'URL', 'Entry URL', 'Service' dropdown, 'Icon', then 'Description', a 'Required ACLs' checkbox grid with a 'custom-acl-key' input and 'Add' button, 'Required feature-list keys', and switches 'Show in menus' and 'Enabled'. Footer 'Cancel' and 'Register'.
  ```

- **Import AppConfig file**

  ```text
  Modal dialog 'Import an AppConfig file', wide, with a note about pasting a .conf containing name=, service=, url=, displayname=, acls= and features=, a large monospace textarea prefilled with a sample, and footer buttons 'Cancel' and 'Parse and review'.
  ```

- **Unregister app confirmation**

  ```text
  Confirmation dialog 'Unregister <app>?', message 'The entry disappears from every menu. The application itself is not touched.', with a red 'Unregister' button and 'Cancel'.
  ```

#### Development Forum

`/development/cpanel-development-forum` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Development Forum', breadcrumb Home > Development > Development Forum, favourite star, description 'Everything a developer integrating with this server needs in one place: the live API reference, hooks and tokens, the plugin SDK, the design documents and the wider community.'. No header actions. Body: a row of stat tiles 'API endpoints', 'API tokens', 'Hooks', 'AppConfig apps', 'Event catalog' and 'Plugin SDK' with small hint lines and a version or 'missing' pill. Then two side-by-side cards: 'Build against this panel' listing links to the admin and account OpenAPI references, 'Manage API Tokens', 'Manage Hooks', 'Apps Managed by AppConfig' and 'Plugin File Generator' with one-line explanations; and 'Community and upstream references' listing four external links with descriptions. Card 'Quickstart' with a 'Copy' button and a monospace shell block. Card 'Design documents', subtitle 'Served from the install under Developer Documentation.', as a grid of document tiles. Card 'Runtime' with a key/value list of 'Panel version', 'Mode', 'Node', 'Hooks directory', 'Hooks globally', 'Last event' and 'SDK path'.
```

#### Plugin File Generator

`/development/cpanel-plugin-file-generator` · form

```text
Desktop admin panel screen, 1440px. Page header 'Plugin File Generator', breadcrumb Home > Development > Plugin File Generator, favourite star, description 'Scaffold a plugin.'. Header action: a pill reading 'SDK <version>'. Body: card 'Plugin identity', subtitle 'Produces plugin.json, index.js and README.md that validate against the plugin SDK manifest contract.', with a two-column grid of 'Plugin id', 'Name', 'Version', 'License', 'Author', 'Author email', 'Sidebar category' and 'Isolation', then 'Description' textarea, 'Keywords', and three switches 'Sidebar page', 'Settings schema' and 'Background job + nightly cron'. Card 'Permissions' with a checkbox grid of scope codes and descriptions and a note about parameterised scopes. Card 'Hooks' with 'Event' and 'Stage' dropdowns, an 'Add hook' button and removable hook chips. Footer buttons 'Preview files' and a primary 'Generate .tar.gz'.
```

Sub-screens (1):

- **Generated file preview**

  ```text
  Drill-down card 'Preview: <dirname>/' appearing under the form, subtitle saying whether the manifest validates, with a 'valid manifest' or error-count pill and a 'Copy' button, a list of validation errors, a tab strip of file paths plplus a tall monospace viewer for the selected file.
  ```

#### Developer Documentation

`/development/developer-documentation` · explorer

```text
Desktop admin panel screen, 1440px. Page header 'Developer Documentation', breadcrumb Home > Development > Developer Documentation, favourite star, description 'The design documents and contracts this panel is built from, served from the install so they always match the running version.'. No header actions. Body: card 'Documents' as a grid of document tiles, each with a title and a small line giving the summary, section count or type, or 'not shipped with this install'. Card 'Where to start' with a bulleted list of shortcut links: 'Blueprint §13' which specifies every one of the 212 functions, 'Blueprint §12' on the envelope, pagination and job conventions, 'Category route modules' and 'Function pages', and 'Plugin manifest schema' as the contract the Plugin File Generator targets. Fallback text 'No documents are shipped with this install. Design documents appear here when the install includes them.'
```

Sub-screens (1):

- **Single document view**

  ```text
  Drill-down view: page header shows the document title and summary with header actions 'All documents', 'Copy' and 'Download', plus a small line of file path, size and updated date. Left card 'Sections' with a 'Filter sections…' box and a scrolling list starting at 'Whole document'; right card renders the markdown or JSON body with a 'section' pill.
  ```

#### Manage API Tokens

`/development/manage-api-tokens` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage API Tokens', breadcrumb Home > Development > Manage API Tokens, favourite star, description 'Create and revoke API tokens.'. Header action: a primary 'Create token'. Body: card 'API tokens', subtitle 'Every token on this server. Tokens authenticate with "Authorization: Bearer <token>" and are exempt from CSRF; only a SHA-256 hash is stored.', holding a searchable, sortable, paged table with the search placeholder 'Search name, user or prefix…' and columns 'Name', 'User', 'Prefix', 'Scopes', 'Expires', 'Last used', 'Created', and a row menu of 'Usage', 'Rename', 'Expire now' and 'Revoke'. Expiry cells show pills reading a date, 'expired <date>' or 'never'. Empty state 'No API tokens yet. Create one to script the panel from billing systems, CI or monitoring.' Card 'Using a token' with a monospace curl block and a short note underneath.
```

Sub-screens (6):

- **Create API token**

  ```text
  Modal dialog 'Create API token', wide. Two-column fields 'Name', 'Description', 'Expiry' dropdown, 'Expires at' and 'Issue for user'; a warning banner 'Scopes only restrict the Development API.'; then 'Development API scopes' as a checkbox grid of scope codes. Footer 'Cancel' and 'Create'.
  ```

- **Token created**

  ```text
  Modal dialog 'Token created' with a warning banner 'Copy it now.' saying this is the only time the token is shown, a monospace token block, a 'Copy token' button, and a key/value list of 'Name', 'User', 'Scopes' and 'Expires'. Footer button 'Done'.
  ```

- **Token usage**

  ```text
  Modal dialog 'Usage: <token name>', wide. Key/value list of 'Prefix', 'Last authenticated', 'Created', 'Expires' and 'Status', a short note, then a scrolling table of 'When', 'Action', 'Target', 'Result', 'IP' with the empty line 'No audited activity since the token was issued. Requests made with it appear here.'
  ```

- **Rename token**

  ```text
  Small modal dialog 'Rename token' with fields 'Name' and 'Description' and footer buttons 'Cancel' and 'Save'.
  ```

- **Revoke token confirmation**

  ```text
  Confirmation dialog 'Revoke "<name>"?', message 'Any integration using this token stops authenticating immediately. This cannot be undone.', with a red 'Revoke' button and 'Cancel'.
  ```

- **Expire token confirmation**

  ```text
  Confirmation dialog 'Expire "<name>" now?', message 'The token stays listed for your records but can no longer authenticate.', with a red 'Expire' button and 'Cancel'.
  ```

#### Manage Hooks

`/development/manage-hooks` · data-table

```text
Desktop admin panel screen, 1440px. Page header 'Manage Hooks', breadcrumb Home > Development > Manage Hooks, favourite star, description 'Event hooks for automation.'. Header actions: a primary 'Add hook' and a pill reading 'hooks enabled' or 'hooks paused'. Body: a tab strip 'Hooks', 'Scripts', 'Run log', 'Event catalog', 'Settings' with counts, open on Hooks. Card 'Registered hooks', subtitle explaining that each hook binds an event and stage to an executable under /usr/local/whm/hooks and that a blocking pre hook exiting non-zero rejects the operation, holding a table of 'Hook', 'Event', 'Stage', 'Script', 'Behaviour', 'Last run', 'Runs' with inline buttons 'Test', 'Edit', 'Disable' and 'Delete'. Stage pills read pre or post; last-run pills ok, failed, error. Empty state 'No hooks yet. Add one to notify billing on account creation, gate suspensions, or alert on failed logins.' Card 'Emit an event' with 'Event' and 'Stage' dropdowns, a JSON 'Payload' textarea, an 'Emit' button and a monospace result block.
```

Sub-screens (11):

- **Scripts tab**

  ```text
  Tab view: card 'Hook scripts' describing executables in /usr/local/whm/hooks, with buttons 'Refresh' and 'New script', an info banner 'The hooks directory does not exist yet.' carrying a 'Create directory' button, and a table of 'Script', 'Mode', 'Owner', 'Size', 'Modified', 'Used by', 'State' with 'Edit' and 'Delete' buttons; state pills read runnable or refused.
  ```

- **Run log tab**

  ```text
  Tab view: card 'Run log', subtitle 'Every hook execution with its exit status and output. Pre-stage failures that vetoed an operation show as failed.', with 'All statuses' and 'All events' dropdowns, a 'Refresh' button and a table of 'When', 'Hook', 'Event', 'Trigger', 'Status', 'Exit', 'Duration' and an 'Output' button.
  ```

- **Event catalog tab**

  ```text
  Tab view: card 'Event catalog', subtitle saying the events come from the plugin SDK so plugins and hooks share one vocabulary, with a table of 'Event', 'Stages', 'Cancellable', 'Payload' and 'Hooks', cancellable shown as a 'yes' pill or muted 'no'.
  ```

- **Settings tab**

  ```text
  Tab view: card 'Hook settings' with a switch 'Run hooks' described as pausing every hook without deleting it, numeric fields 'Default timeout (seconds)' and 'Keep run log entries', and a key/value list of 'Scripts directory' and 'Execution'.
  ```

- **Add or edit hook**

  ```text
  Modal dialog 'Add hook' (or 'Edit hook: <name>'), wide. Two-column fields 'Event' and 'Stage' dropdowns, 'Script' dropdown, 'Timeout (seconds)', 'Name' and 'Description', then switches 'Blocking' and 'Enabled' and a payload-shape note. Footer 'Cancel' and 'Add hook'.
  ```

- **Hook script editor**

  ```text
  Modal dialog 'New hook script' (or 'Edit <name>'), wide, with a 'File name' field, a tall monospace 'Script' textarea prefilled with a shell sample that must start with a shebang, a note about backups, and footer buttons 'Cancel' and 'Save as root (0700)'.
  ```

- **Hook test result**

  ```text
  Modal dialog 'Test: <hook name>', wide, with a loading line 'Running the script…', then stat tiles 'Status', 'Exit code' and 'Duration' followed by headings 'stdout' and 'stderr' each over a monospace output block.
  ```

- **Run output**

  ```text
  Modal dialog 'Run #<id> · <hook name>', wide, with a key/value list of 'Event', 'Trigger', 'Status', 'Exit code', 'Duration' and 'When', then 'stdout' and 'stderr' headings over monospace output blocks.
  ```

- **Delete hook confirmation**

  ```text
  Confirmation dialog 'Delete hook "<name>"?', message 'The script stays on disk; only the binding to the event is removed.', with a red 'Delete' button and 'Cancel'.
  ```

- **Delete script confirmation**

  ```text
  Confirmation dialog 'Delete script <name>?', message warning that referencing hooks will start recording errors, or that the file is removed from /usr/local/whm/hooks, with a red 'Delete' button and 'Cancel'.
  ```

- **Emit event confirmation**

  ```text
  Confirmation dialog 'Emit <event> (<stage>)?', message 'Every enabled hook bound to this event runs for real with the payload below.', with an 'Emit' button and 'Cancel'.
  ```

### 30. Plugins

3 screens. Sidebar tile colour for this category is used on its tool cards.

#### ImunifyAV

`/plugins/imunifyav` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'ImunifyAV', breadcrumb Home > Plugins > ImunifyAV, favourite star, description 'Malware scanner. ImunifyAV <version>.'. Below the header a segmented control 'Overview', 'Findings', 'Settings' and a ghost 'Manage Plugins' link. Body: card 'Scanner' with a 'Refresh' button and four stat tiles 'ImunifyAV', 'ClamAV fallback', 'Active scanner' and 'Recorded findings' with installed or not-installed pills and small sub-lines; an info banner 'No malware scanner is installed on this server' holding monospace install steps; then a 'Directory to scan' field and buttons 'Start ImunifyAV scan' and 'Scan all accounts with ClamAV', with a streaming progress log below. Card 'Malicious files' with a 'Clear findings' button and a table of 'Detected', 'Account', 'File', 'Signature', 'Status'. Card 'Quarantine' with the same columns and the empty state 'Files ImunifyAV moves to quarantine appear here'.
```

Sub-screens (5):

- **Findings tab**

  ```text
  Tab view from the segmented control: the plugin's own findings page rendered as a card with a table of the columns the plugin manifest declares, a refresh action and an empty state for when nothing has been recorded.
  ```

- **Settings tab**

  ```text
  Tab view: card holding the plugin's settings form built from its manifest schema, a mix of text inputs, switches and dropdowns for scan schedule and scanner choice, with a 'Save' button and a success message after saving.
  ```

- **Plugin not enabled state**

  ```text
  Alternate page state: card titled 'ImunifyAV' with a state pill, an empty-state block 'The plugin is not enabled' over the plugin description, buttons 'Enable plugin' and 'Repair (reinstall and enable)', and a muted line pointing at 'Manage Plugins'.
  ```

- **Start scan confirmation**

  ```text
  Confirmation dialog 'Start a malware scan', message 'Scan every account home directory with ClamAV now? This can take a long time on a busy server.' or asking to start an ImunifyAV on-demand scan of the chosen path, with a 'Start scan' button and 'Cancel'.
  ```

- **Clear findings confirmation**

  ```text
  Confirmation dialog 'Clear findings', message 'Remove every recorded finding from the plugin store? Files on disk are not touched.', with a red 'Clear' button and 'Cancel'.
  ```

#### Server Monitoring

`/plugins/server-monitoring` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'Server Monitoring', breadcrumb Home > Plugins > Server Monitoring, favourite star, description 'Metrics and alerts. Server Monitoring <version>.'. Below the header a segmented control 'Overview', 'Alerts', 'Settings' and a ghost 'Manage Plugins' link. Body: card 'Current', subtitle giving the last sample time, sample count, retention days and sampling interval, with buttons 'Sample now' and 'Refresh', and four stat tiles 'Load (1 / 5 / 15 min)', 'Memory used', 'Disk used (fullest mount)' and 'Network in / out', each with a sub-line and an 'over threshold' pill when exceeded; a warning banner listing active alerts; an info banner when sampling is switched off. Card 'History' with a segmented range control 'Last hour', '6 hours', '24 hours', '7 days' and four line charts headed 'Load (1 min)', 'Memory used', 'Disk used' and 'Network', each with a dashed alert threshold rule, plus a collapsible 'Table view' of 'Time', 'Load', 'Memory %', 'Disk %', 'In', 'Out'. Empty state 'No samples in this range'.
```

Sub-screens (3):

- **Alerts tab**

  ```text
  Tab view from the segmented control: the plugin's alerts page as a card with a table of recorded alerts built from its manifest columns, showing metric, threshold, since and state, and an empty state when none have fired.
  ```

- **Settings tab**

  ```text
  Tab view: card with the plugin's settings form generated from its manifest schema — a sampling switch, interval and retention numbers and per-metric alert thresholds — with a 'Save' button.
  ```

- **Plugin not enabled state**

  ```text
  Alternate page state: card titled 'Server Monitoring' with a state pill and an empty-state block 'The plugin is not enabled' over the description, buttons 'Enable plugin' and 'Repair (reinstall and enable)', and a line pointing at 'Manage Plugins'.
  ```

#### WP Toolkit

`/plugins/wp-toolkit` · dashboard

```text
Desktop admin panel screen, 1440px. Page header 'WP Toolkit', breadcrumb Home > Plugins > WP Toolkit, favourite star, description 'WordPress management. WP Toolkit <version>.'. Below the header a segmented control 'Overview', 'Discover', 'Settings' and a ghost 'Manage Plugins' link. Body: card 'WP-CLI' with buttons 'Discover sites' and 'Install WordPress' and four stat tiles 'WP-CLI', 'WordPress sites', 'Core updates pending' and 'Accounts', plus a warning banner 'WP-CLI is not installed' holding monospace install steps. Card 'WordPress sites' with a table of 'Account', 'Path', 'WordPress', 'Updates', 'Maintenance' and a 'Manage' button per row, pills reading core current, core <version>, on; empty state 'WordPress installations found under the account web roots appear here; use Discover sites to search them'. Card 'Recent installs' with 'Requested', 'Account', 'URL', 'Database', 'Status', 'Error'.
```

Sub-screens (6):

- **Install WordPress form**

  ```text
  Expanded card 'Install WordPress', subtitle 'Creates the database and database user, checks the virtual host and runs the WP-CLI installer as the account user', with a two-column grid of 'Account', 'Directory below public_html', 'Site URL', 'Site title', 'Admin user', 'Admin email', 'Admin password', 'Database name' and 'Locale', an 'Install WordPress' button and a streaming progress log.
  ```

- **Site detail**

  ```text
  Drill-down card '<account> · <path>' with 'Re-inspect' and 'Close' buttons, a key/value list of 'WordPress', 'Site URL', 'Core update', 'Maintenance mode', 'Administrators', 'Database', 'Inspected', buttons 'Update core', 'Update all plugins', 'Update all themes', a 'Maintenance mode' switch, then tables 'Plugins' and 'Themes' with 'Name', 'Status', 'Version', 'Update', and a 'Hardening' table of 'Result', 'Check', 'Detail' and a 'Fix' button, with 'Apply all <n> fixes'.
  ```

- **Discover tab**

  ```text
  Tab view from the segmented control: the plugin's discovery page as a card listing the accounts and web roots searched for wp-config.php, with a run action and a table of what the last scan found.
  ```

- **Settings tab**

  ```text
  Tab view: card with the plugin's settings form built from its manifest schema, covering discovery scope and update behaviour, with a 'Save' button.
  ```

- **Plugin not enabled state**

  ```text
  Alternate page state: card titled 'WP Toolkit' with a state pill and an empty-state block 'The plugin is not enabled' over the description, buttons 'Enable plugin' and 'Repair (reinstall and enable)', and a line pointing at 'Manage Plugins'.
  ```

- **Update confirmation**

  ```text
  Confirmation dialog 'Update', message 'Update WordPress core on <path> now? WP-CLI runs as <account>; put the site in maintenance mode first if visitors should not see it mid-update.', with an 'Update' button and 'Cancel'.
  ```


## 5. Account panel — 64 screens

Port 2083, routes under `/panel`. The reader is the hosting customer. Same shell, same components.

### 1. Overview

3 screens. Sidebar tile colour for this category is used on its tool cards.

#### Dashboard

`/panel/overview/dashboard` · dashboard

```text
Desktop account panel screen, 1440px. Page header 'Dashboard', breadcrumb Home > Overview > Dashboard, favourite star, description 'Usage at a glance, your domains and quick links.' No header actions. Body: a news banner, then small outbound link buttons 'Webmail' and operator app shortcuts. Two columns. Main column: card 'Usage' with a 'Details' link and stat tiles 'Disk', 'Bandwidth this month', 'Mailboxes', 'Databases', 'Addon domains', 'Subdomains', 'FTP accounts', each a value like '2.1 GB of 10 GB' above a meter; card 'Favorites', subtitle 'Your pinned tools', with a collapse chevron; card 'Tools' with 'Expand all', 'Collapse all' and a 'Filter tools…' search, then collapsible category sections, each an icon tile, name and count, holding tool cards of icon, name, one-line description and a pin star. Side column: card 'Domains' with a 'Manage' link, each row a domain link, its document root and a 'main' or 'addon' pill; card 'Account' listing 'Username', 'Main domain', 'IP address', 'Plan', 'Server' and 'Status' with an 'active' pill. Empty state 'No domains on this account yet.'
```

#### Account details

`/panel/overview/account` · viewer

```text
Desktop account panel screen, 1440px. Page header 'Account details', breadcrumb Home > Overview > Account details, favourite star, description 'Your account, plan limits and included features.' Header actions: 'Change password' and 'Two-factor authentication'. Body in two columns. Left: card 'Account', a label and value list of 'Username', 'Main domain', 'IP address', 'Plan', 'Contact email', 'Home directory' in monospace, 'Shell access', 'Server', 'Created', 'Status' and 'Demo mode'; card 'Sign-in' listing 'Login', 'Email', 'Two-factor authentication', 'Two-factor required' and 'Password in sync with the server'. Right: card 'Plan limits', subtitle 'What this plan allows on the account.', listing 'Disk space', 'Bandwidth per month', 'Addon domains', 'Subdomains', 'Parked domains', 'Mailboxes', 'Databases', 'FTP accounts', 'Outgoing mail per hour' and 'Files (inodes)'; card 'Included features', a table with columns 'Feature' and right-aligned 'Status', each row a feature name like 'SSL › AutoSSL' above its key in monospace. Pills read 'enabled', 'disabled', 'active', 'required', 'read-only' and 'not yet'; empty state 'No limits are set on this plan.'
```

#### Preferences

`/panel/overview/preferences` · form

```text
Desktop account panel screen, 1440px. Page header 'Preferences', breadcrumb Home > Overview > Preferences, favourite star, description 'Contact addresses, language and notifications.' No header actions. Body in two columns. Left: card 'Contact information', subtitle 'Where the server reaches you: password resets and the notices below go to these addresses.', with a form of required filled input 'Contact email' helped by 'Also the address the sign-in page sends password-reset links to.', input 'Second contact email' helped by 'Optional. Gets a copy of every notice.', a 'Notifications' group of three switches 'Disk quota', 'Bandwidth' and 'Password changes' each with a line of description, a required password input 'Current password', and a primary 'Save' button. Right: card 'Language', subtitle 'The language of this panel for your login. The server default applies until you pick one.', with a 'Language' dropdown listing 'Server default (en)' and each installed language, and a primary 'Save language' button. An error banner above the form reads 'Check the addresses'.
```

### 2. Domains

5 screens. Sidebar tile colour for this category is used on its tool cards.

#### Domains

`/panel/domains/domains` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Domains', breadcrumb Home > Domains, favourite star, description 'Every domain on this account and where it is served from.' Header actions: three outline buttons with plus icons, 'Addon domain', 'Subdomain', 'Parked domain'. Body: a row of three stat tiles 'Addon domains', 'Subdomains', 'Parked domains', each a big count over small text 'of 5 allowed'. Below, card 'Domains on this account', subtitle 'example.com is the main domain. Where each name is served from, and whether the web server and SSL are in place.', holding a search box 'Search domains…', a segmented control 'All' 'Main' 'Addon' 'Subdomains' 'Parked', and a table with columns 'Domain', 'Type', 'Document root', 'Web server', 'SSL', 'PHP', 'Added'. Cells use pills 'Main domain', 'Addon domain', 'Serving', 'Pending', 'Valid · 60 d', 'None', monospaced roots like ~/public_html, and 'Default' for PHP. Row '…' menu: 'DNS records', 'Redirect', 'Manage addon domains'. Empty state 'No domains match this filter'.
```

#### Addon domains

`/panel/domains/addon-domains` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Addon domains', breadcrumb Home > Domains > Addon domains, favourite star, description 'Host additional websites on this account.' Header action: primary button with plus icon 'Add addon domain'. Body: an amber warning banner 'All 5 addon domains of your plan are in use' with 'Remove one to make room, or ask your hosting provider about a larger plan.'; after a create, a result card 'example.org is set up' with a key-value list 'Document root', 'DNS zone', 'Web server', 'Mail routing' showing pills 'Created', 'Configured', 'Local', and a 'Dismiss' button. Main card 'Addon domains' with subtitle '2 of 5 addon domains' and a table: columns 'Domain', 'Document root', 'Web server', 'SSL', 'Added', status pills in the web-server and SSL cells, row '…' menu with a red 'Remove'. Empty state: 'No addon domains yet. Add one to host another website on this account; it gets its own folder under public_html.'
```

Sub-screens (2):

- **Add an addon domain**

  ```text
  Modal dialog 'Add an addon domain'. Filled text field 'Domain' marked required with help 'A registered name whose nameservers point at this server, e.g. example.org', text field 'Document root' with help about public_html, and a switch 'Create a DNS zone' with explanatory text. Footer buttons 'Cancel' and primary 'Add domain'.
  ```

- **Remove addon domain**

  ```text
  Modal dialog 'Remove example.org?', small width. Paragraph 'example.org stops being served by this account. Visitors get an error until the name points somewhere else.' Two switches: 'Delete its DNS zone' on, 'Delete the document root' off with a warning that it cannot be undone. Buttons 'Cancel' and red 'Remove'.
  ```

#### Subdomains

`/panel/domains/subdomains` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Subdomains', breadcrumb Home > Domains > Subdomains, favourite star, description 'Sections of your sites under their own hostname.' Header action: primary button with plus icon 'Add subdomain'. Body: an amber plan-limit banner when full, and an amber banner 'Subdomains are not published from here' explaining that DNS for the parent domain is managed at another provider, with the records to copy listed in monospace. After a create, a result card 'shop.example.com is set up' with a key-value list 'Document root', 'DNS record', 'Web server' and a 'Dismiss' button. Main card 'Subdomains' with subtitle '3 of 10 subdomains' and a table: columns 'Subdomain', 'Document root', 'Web server', 'SSL', 'Added', status pills for web server and SSL, row '…' menu with a red 'Remove'. Empty state: 'No subdomains yet. Add one to serve a section of your site, such as shop or blog, from its own folder.'
```

Sub-screens (2):

- **Add a subdomain**

  ```text
  Modal dialog 'Add a subdomain'. Two fields side by side: required text field 'Name' with help 'Becomes shop.example.com', and required dropdown 'Under' listing the main and addon domains. Below, full-width text field 'Document root' with help about public_html. Buttons 'Cancel' and primary 'Add subdomain'.
  ```

- **Remove subdomain**

  ```text
  Modal dialog 'Remove shop.example.com?', small width. Paragraph explaining the subdomain stops being served and visitors get an error. One switch 'Delete the document root', off, warning that it removes every file and cannot be undone. Buttons 'Cancel' and red 'Remove'.
  ```

#### Parked domains

`/panel/domains/parked-domains` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Parked domains', breadcrumb Home > Domains > Parked domains, favourite star, description 'Aliases that show the same site as another domain.' Header action: primary button with plus icon 'Park a domain'. Body: an amber banner 'Your plan does not include parked domains' with 'Ask your hosting provider about a plan that includes them.'; after a create, a result card 'example.net is parked' with a key-value list 'Shows', 'DNS zone', 'Web server' showing pills 'Created' and 'Alias added', plus a 'Dismiss' button. Main card 'Parked domains', subtitle '1 of 3 parked domains', table with columns 'Parked domain', 'Shows', 'Web server', 'SSL', 'Added' and status pills; row '…' menu with a red 'Remove'. Empty state: 'No parked domains yet. Park one to show example.com under another name, for example a .net or a misspelling you own.'
```

Sub-screens (2):

- **Park a domain**

  ```text
  Modal dialog 'Park a domain'. Grey intro line 'A parked domain shows the same site as example.com. Visitors keep the address they typed.' Required text field 'Domain' with help 'A registered name whose nameservers point at this server'. Switch 'Create a DNS zone', on. Buttons 'Cancel' and primary 'Park domain'.
  ```

- **Stop parking a domain**

  ```text
  Modal dialog 'Stop parking example.net?', small width. Paragraph explaining the name stops being served by this account. One switch 'Delete its DNS zone', on, described as removing the records of this domain on this server. Buttons 'Cancel' and red 'Remove'.
  ```

#### Redirects

`/panel/domains/redirects` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Redirects', breadcrumb Home > Domains > Redirects, favourite star, description 'Send visitors from one address to another.' Header action: primary button with plus icon 'Add redirect'. Body: an informational banner 'Redirects are saved but not yet applied' with 'The web server on this host cannot apply them yet; they take effect as soon as it can.' Card 'Redirects' with subtitle '2 of 6 domains redirect somewhere else' and, in its header, a switch 'Only domains with a redirect'. Inside, a table with columns 'Domain', 'Redirects to', 'Type', 'Options', 'Status', 'Updated'; targets are links, type reads 'Permanent (301)' or 'Temporary (302)', options read 'www · keeps path', status is a pill 'Active', 'Pending' or 'Failed', rows without a redirect are greyed with 'No redirect yet'. Row '…' menu: 'Edit' and a red 'Remove'.
```

Sub-screens (3):

- **Add a redirect**

  ```text
  Modal dialog 'Add a redirect'. Required dropdown 'Domain', required text field 'Redirects to' with help 'An absolute address starting with http:// or https://', dropdown 'Type' with the long 301 and 302 options, then switches 'Also redirect www.example.com' and 'Keep the requested path' showing an example path. Buttons 'Cancel' and primary 'Add redirect'.
  ```

- **Edit the redirect of a domain**

  ```text
  Modal dialog 'Edit the redirect of example.com'. Same form with the 'Domain' dropdown locked to that domain, the target address prefilled, the type dropdown and the two switches set from the saved redirect. Buttons 'Cancel' and primary 'Save redirect'.
  ```

- **Remove redirect confirmation**

  ```text
  Confirmation dialog 'Remove the redirect of example.com?' with the message 'example.com stops sending visitors to https://www.example.org/ and serves its own files again.' Buttons 'Cancel' and red 'Remove'.
  ```

### 3. DNS

3 screens. Sidebar tile colour for this category is used on its tool cards.

#### Zone editor

`/panel/dns/zone-editor` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Zone editor', breadcrumb Home > DNS > Zone editor, favourite star, description 'A, AAAA, CNAME, MX, TXT, SRV and CAA records for your domains.' Header action: primary button with plus icon 'Add record'. Body: a card titled with the zone name 'example.com', subtitle 'Only the records you can change are listed; nameservers and the SOA are managed by your provider.', a zone dropdown and a 'Published · serial 2026110701' indicator in its header, and six stat tiles 'Records', 'Default TTL', 'Serial', 'Last change', 'DNS server' with a pill 'Serving this zone', 'Public DNS' with a pill 'Delegated here' or 'Managed elsewhere'. Then an information banner 'Changes are saved, not yet served'. Card 'Records' with a search box 'Search names and values…', a segmented control 'All 24' and one button per type with its count, and a table with columns 'Name', 'Type', 'TTL', 'Priority', 'Value'. Row '…' menu: 'Edit' and a red 'Delete'.
```

Sub-screens (5):

- **Add a record**

  ```text
  Modal dialog 'Add a record'. Paired dropdown 'Type' (A, AAAA, CNAME, MX, TXT, SRV, CAA) and text field 'Name' with help 'Blank for example.com itself; becomes www.example.com'. Below, the fields of the chosen type, then 'TTL' with help about the zone default. Buttons 'Cancel' and primary 'Add record'.
  ```

- **Edit a record**

  ```text
  Modal dialog 'Edit MX record' with the type dropdown locked. Number field 'Priority' with help 'Lower numbers are tried first' beside text field 'Mail server', and 'TTL' below, all prefilled from the stored record. Buttons 'Cancel' and primary 'Save record'.
  ```

- **SRV and CAA record fields**

  ```text
  Modal dialog 'Add a record' with type SRV: three number fields 'Priority', 'Weight', 'Port' in a row above 'Target'. The CAA variant instead shows dropdowns 'Flags' and 'Tag' over a field 'Certificate authority' with help 'e.g. letsencrypt.org'.
  ```

- **Delete record confirmation**

  ```text
  Confirmation dialog 'Delete this A record?' whose message is the record itself on one line, name, type, priority and value in monospace. Buttons 'Cancel' and red 'Delete'.
  ```

- **No zones empty state**

  ```text
  Alternate body state: a single card with the empty-state heading 'No DNS zones on this account' and the text 'A zone appears here for every domain whose DNS is hosted on this server. Addon and parked domains can create one when they are added.' No table, no header action.
  ```

#### Dynamic DNS

`/panel/dns/dynamic-dns` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Dynamic DNS', breadcrumb Home > DNS > Dynamic DNS, favourite star, description 'Keep an A or AAAA record pointed at a changing address with a private update URL.' Header action: primary button with plus icon 'Create update URL'. Body: an amber banner 'Dynamic DNS is unavailable for this zone' naming the provider that holds the DNS. Card 'Update URLs' with subtitle '3 of 20 update URLs used' and a table with columns 'Record' (hostname plus a small type pill), 'Label', 'Current value' in monospace, 'Last update' with the address underneath or 'never', and a right-aligned 'Updates' count. Row '…' menu with a red 'Revoke'. Below the card, an information banner 'How it works' explaining that each URL is tied to one A or AAAA record, opened by a router or cron line after every address change, and that anyone holding it can move the record. Empty state: 'No update URLs yet. Create one for an A or AAAA record to keep it pointed at a home or office connection.'
```

Sub-screens (3):

- **Create a dynamic DNS update URL**

  ```text
  Modal dialog 'Create a dynamic DNS update URL'. Required dropdown 'Zone' with ineligible zones greyed and suffixed 'DNS managed elsewhere', required dropdown 'Record' listing host, type and value, and text field 'Label' with help 'Optional: which device or site uses this URL'. Buttons 'Cancel' and primary 'Create update URL'.
  ```

- **Update URL created**

  ```text
  Modal dialog 'Update URL created'. Paragraph warning the URL is shown only once. Field 'Update URL' showing the long URL in monospace beside a 'Copy' button with a copy icon, then a grey line and a code block with a cron example using curl every five minutes. Single primary button 'Close'.
  ```

- **Revoke update URL confirmation**

  ```text
  Confirmation dialog 'Revoke the update URL for home.example.com?' with the message 'Devices still using it answer 404 from then on.' Buttons 'Cancel' and red 'Revoke'.
  ```

#### Track DNS

`/panel/dns/track` · form

```text
Desktop account panel screen, 1440px. Page header 'Track DNS', breadcrumb Home > DNS > Track DNS, favourite star, description 'Look up the records of any domain and trace the route from this server to a host.' No header actions. Body: two stacked cards. First, 'Domain lookup' with subtitle 'Ask the name servers this server uses for the records of any domain.', holding a filled text field 'Domain or host' prefilled with the account domain beside a dropdown 'Record type' offering A, AAAA, MX, NS, TXT, CNAME, SOA and PTR, and a primary button 'Look up' with a magnifier icon. Second, 'Trace route' with subtitle 'Show the path packets take from this server to a host, hop by hop. A trace takes up to a minute.', a single text field 'Host or IP address' and a primary button 'Trace' with a route icon.
```

Sub-screens (3):

- **Lookup result**

  ```text
  Result region inside the 'Domain lookup' card, under the form: a two-column table with headers 'Type' and 'Answer', each row showing the record type and one answer in monospace. The empty variant is a centred state 'A records of example.com' with 'No records of this type were found.'
  ```

- **Trace route result**

  ```text
  Result region inside the 'Trace route' card: a green 'Reached' pill followed by 'Reached example.com in 12 hops.', then a table with headers 'Hop', 'Address' and 'Round trip'; addresses are monospace chips, unanswered hops read 'no reply' and round trips show milliseconds or asterisks.
  ```

- **Trace in progress**

  ```text
  Loading state of the 'Trace route' card: the 'Trace' button shows a spinner and is disabled, and a grey line under the form reads 'Tracing… this can take up to a minute.' No results table yet.
  ```

### 4. SSL

3 screens. Sidebar tile colour for this category is used on its tool cards.

#### SSL status

`/panel/ssl/status` · data-table

```text
Desktop account panel screen, 1440px. Page header 'SSL status', breadcrumb Home > SSL > SSL status, favourite star, description 'Certificates installed on each domain.' Header actions: a primary 'Install certificate' button. Body: a row of four stat tiles 'Domains', 'Secured', 'Expiring within 30 days', 'Without a certificate'; a success banner 'Free certificates are issued automatically' with a line about daily checks and renewal; a notice 'Certificates need the name to resolve to this server'; then one bordered card holding a searchable table, search placeholder 'Search domains…', columns 'Domain' (name with a small type pill), 'Certificate', 'Issued by', 'Expires', 'Last AutoSSL run', and a row '...' menu with 'Issue now', 'Details', 'Replace certificate', 'Remove certificate'. Empty state 'No domains to secure yet'. Footnote linking to 'Certificates'.
```

Sub-screens (4):

- **Domain details dialog**

  ```text
  Modal dialog titled with the domain name. A key/value list 'State' with a status pill, 'Files on the server' reading present or missing, 'Chain' reading included or none, then a certificate summary listing 'Issued to', 'Also covers', 'Issued by', 'Valid from', 'Expires' and 'Fingerprint (SHA-256)'. Close button only.
  ```

- **Domain details, nothing installed**

  ```text
  Modal dialog titled with the domain name showing an empty state 'No certificate installed', the line 'Nothing is installed on example.com yet.' and a small 'Install a certificate' button. No other fields.
  ```

- **Remove certificate confirmation**

  ```text
  Confirmation dialog 'Remove the certificate from example.com?' with the message 'Visitors will see a browser warning on https:// until a new certificate is installed. The stored copy stays under Certificates.' Buttons 'Cancel' and a red 'Remove'.
  ```

- **Issuing in progress card**

  ```text
  Alternate state of the main screen: above the table a card titled 'Issuing a certificate for example.com' with a 'Close' button in its header and an information banner reading 'Issuing a certificate for example.com; the table updates in a minute.' plus a muted line that the server is working in the background.
  ```

#### Install certificate

`/panel/ssl/install` · form

```text
Desktop account panel screen, 1440px. Page header 'Install certificate', breadcrumb Home > SSL > Install certificate, favourite star, description 'Issue a free certificate or install your own.' Header actions: an 'SSL status' button. Body: card 'Domain', subtitle 'Pick the domain the certificate is for.', with a required dropdown 'Install on' and beside it 'Current certificate' showing a state pill, 'Issued by' text and an expiry pill. Card 'Free certificate' with a primary 'Issue now' button in its header and the muted line 'Issuing takes about a minute. Progress shows here.' Card 'Your own certificate' with a two-tab segmented control 'Paste' and 'Stored certificate'; the paste tab shows three tall monospace fields 'Certificate (PEM)', 'Private key (PEM)' and 'Chain / CA bundle (PEM)' above a primary 'Install certificate' button.
```

Sub-screens (3):

- **Stored certificate tab**

  ```text
  Alternate state of the 'Your own certificate' card with the 'Stored certificate' tab active: one dropdown 'Stored certificate' listing entries as domain, issuer and expiry date, the help line 'The key stored with it is used automatically.', a warning banner when no key is stored, and the 'Install certificate' button.
  ```

- **Issuing progress state**

  ```text
  Alternate state of the 'Free certificate' card: an information banner 'Issuing a free certificate for example.com; the current certificate above updates in a minute.' with a muted line that the server is working in the background, replacing the usual helper text.
  ```

- **Installed result card**

  ```text
  Alternate state: an extra card at the bottom titled 'Installed on example.com' with a key/value list 'State' as a status pill and 'Web server' as an applied or pending pill, followed by a certificate summary of issued to, also covers, issued by, valid from, expires and fingerprint.
  ```

#### Certificates

`/panel/ssl/certificates` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Certificates', breadcrumb Home > SSL > Certificates, favourite star, description 'Certificates, keys and signing requests stored for this account.' Header actions: 'Generate signing request', 'Self-signed certificate' and a primary 'Upload'. Body: three stat tiles 'Certificates', 'Private keys', 'Signing requests'; then a card holding a table with a segmented filter 'All', 'Certificates', 'Keys', 'Signing requests', search placeholder 'Search by name or issuer…', sortable columns 'Name', 'Contents' (small pills reading certificate, private key, signing request, chain), 'Issued by', 'Expires', 'State', 'Added', and a row '...' menu with 'Install', 'Download certificate', 'Download full chain', 'Download signing request', 'Delete'. Empty state 'Nothing stored yet'. Footnote that private keys are stored encrypted and never downloadable.
```

Sub-screens (6):

- **Generate signing request dialog**

  ```text
  Large modal dialog 'Generate a signing request' with an explanatory paragraph, fields 'Domain' (required), 'Additional names' textarea, 'Key type' and 'Key size' dropdowns, then a subject grid 'Organization', 'Department', 'City', 'State or province', 'Country (two letters)', 'Email'. Footer buttons 'Cancel' and 'Generate'.
  ```

- **Generate self-signed certificate dialog**

  ```text
  Large modal dialog 'Generate a self-signed certificate', same fields as the signing request plus a numeric 'Valid for (days)' field, and a paragraph warning that browsers warn visitors about self-signed certificates. Footer buttons 'Cancel' and 'Generate'.
  ```

- **Generate result view**

  ```text
  Modal dialog result state: a warning banner 'Save the private key now.' explaining it can never be downloaded again, then two read-only monospace blocks 'Signing request (send this to your certificate authority)' and 'Private key', each with 'Copy' and 'Save as' buttons. Footer button 'Done'.
  ```

- **Upload dialog**

  ```text
  Large modal dialog 'Upload a certificate, key or signing request' with an optional 'Domain' dropdown placeholder 'From the certificate' and four monospace textareas 'Certificate (PEM)', 'Private key (PEM)', 'Chain / CA bundle (PEM)', 'Signing request (PEM)'. Footer buttons 'Cancel' and 'Upload'.
  ```

- **Upload result view**

  ```text
  Modal dialog result state showing a key/value list 'Stored as' with the domain and 'Contents' as small pills, followed by a certificate summary of issued to, issued by, valid from, expires and fingerprint. Footer button 'Done'.
  ```

- **Delete stored item confirmation**

  ```text
  Confirmation dialog 'Delete the stored certificate, private key for example.com?' with the message 'This cannot be undone. A private key deleted here is gone for good.' Buttons 'Cancel' and a red 'Delete'.
  ```

### 5. Files

6 screens. Sidebar tile colour for this category is used on its tool cards.

#### File manager

`/panel/files/file-manager` · explorer

```text
Desktop account panel screen, 1440px. Page header 'File manager', breadcrumb Home > Files > File manager, favourite star, description 'Browse, upload, edit and organise the files of your sites.' Header actions: 'New file', 'New folder', and a primary 'Upload'. Body: one card whose top row holds an up-one-level arrow button, a folder trail starting at 'Home' with chevrons between segments, a '~/' prefixed 'Go to a folder' box with a 'Go' button and a refresh button. Below it a warning banner 'Only the first 1,000 of 4,210 entries are shown'. Then a dense table with row checkboxes and columns 'Name' (file or folder icon plus name), 'Size' right aligned, 'Modified' and 'Permissions' shown as code. Table toolbar: a 'Filter this folder' search, a 'Hide hidden' toggle, and when rows are picked '3 selected' with 'Compress', 'Delete' and 'Clear'. Row '...' menu: 'Open', 'Edit', 'Download', 'Rename', 'Copy to...', 'Permissions', 'Compress', 'Extract', 'Delete'. Card footer: '24 items' on the left, link 'Disk usage of this folder' on the right. Empty state 'This folder is empty. Upload files or create a new file or folder with the buttons above.' A drag overlay reads 'Drop files to upload them to ~/public_html'.
```

Sub-screens (13):

- **New folder dialog**

  ```text
  Modal dialog 'New folder', small. One required filled field 'Folder name' with helper text 'Created in ~/public_html with mode 0755' and an inline error 'A name without "/"; "." and ".." are not allowed'. Footer buttons 'Cancel' and a primary 'Create folder'.
  ```

- **New file dialog**

  ```text
  Modal dialog 'New file', small. Required filled field 'File name' with helper text 'An empty file in ~/public_html; open it afterwards to add content'. Footer buttons 'Cancel' and a primary 'Create file'.
  ```

- **Rename dialog**

  ```text
  Modal dialog 'Rename index.html', small. Required filled field 'New name' pre-filled with the current name, with an inline error 'index.html already exists in this folder'. Footer buttons 'Cancel' and a primary 'Rename'.
  ```

- **Copy to dialog**

  ```text
  Modal dialog 'Copy index.html', small. Required field 'Copy to' as an input group with a '~/' prefix, helper text 'The full destination path relative to your home directory, including the new name'. Footer buttons 'Cancel' and a primary 'Copy'.
  ```

- **File editor dialog**

  ```text
  Modal dialog 'Edit public_html/index.html', large. Warning banner 'Only the first 4 MB are shown'. A tall monospaced code textarea filling the body. Footer shows '12.4 KB · 0644 · saved 4 Mar 2026 · unsaved changes' on the left, then buttons 'Discard' and a primary 'Save'.
  ```

- **Delete confirmation**

  ```text
  Confirmation dialog 'Delete 3 items?' with the message 'They are removed permanently, including everything inside the folders. There is no trash to recover from.' and a type-to-confirm box where the word 'delete' must be typed. Buttons 'Cancel' and a red 'Delete'.
  ```

- **Discard edits confirmation**

  ```text
  Confirmation dialog 'Discard the changes?' with the message 'Everything typed since the last save is lost.' Buttons 'Cancel' and a red 'Discard'.
  ```

- **Upload dialog**

  ```text
  Modal dialog 'Upload to ~/public_html', medium. A dashed drop zone holding a 'Files' file picker, helper text 'Up to 20 GB per file; large files are sent in pieces', and the line 'Or drop files here. An upload interrupted by a connection loss resumes where it stopped.' A switch 'Replace files that already exist'. A list of picked files with sizes. Buttons 'Close' and primary 'Upload 3 files (12.4 MB)'.
  ```

- **Upload in progress**

  ```text
  Modal dialog 'Upload to ~/public_html' showing progress: one row per file with the file name on the left and '4.2 MB of 12.4 MB · running' on the right, a thin progress meter under each, one row red and labelled 'failed'. Buttons 'Cancel' and 'Upload more'.
  ```

- **Permissions dialog**

  ```text
  Modal dialog 'Permissions of index.html', small. A small table with rows 'Owner (you)', 'Group', 'Everyone else' and right-aligned checkbox columns 'Read', 'Write', 'Execute'. Below, a narrow 'Mode' field showing 0644 with helper 'Shown as -rw-r--r--', a switch 'Apply to everything inside', and an advice note. Buttons 'Cancel' and primary 'Save permissions'.
  ```

- **Compress dialog**

  ```text
  Modal dialog 'Compress 3 items', medium. A 'Format' dropdown with 'Zip (.zip)' and 'Gzipped tar (.tar.gz)', a required 'Archive name' field with helper 'Created in ~/public_html; it must end in .zip', and the note '3 items will be included. Existing archives are never overwritten.' Buttons 'Cancel' and primary 'Create archive'.
  ```

- **Extract dialog**

  ```text
  Modal dialog 'Extract backup.zip', medium. One field 'Extract into' as an input group with a '~/' prefix and placeholder public_html, helper 'A folder relative to your home directory; leave empty for the home directory itself. It is created if missing.' Buttons 'Cancel' and primary 'Extract'.
  ```

- **Archive job progress**

  ```text
  Modal dialog showing a running archive job: a status pill reading 'running', a progress bar with '62% · adding files' beside it, and a dark scrolling log pane of timestamped lines. Single footer button 'Close'.
  ```

#### Disk usage

`/panel/files/disk-usage` · explorer

```text
Desktop account panel screen, 1440px. Page header 'Disk usage', breadcrumb Home > Files > Disk usage, favourite star, description 'Which folders use the most space.' Header action: 'Refresh'. Body: a row of three stat tiles. First, 'Your home directory uses' with a large byte figure, a meter and the line '38% of the plan's 5 GB'. Second, 'Whole account' with the used megabytes, a meter and 'of 5 GB · includes mail and databases'. Third, 'Sub-folders' with a count and 'Measured 4 Mar 2026; the figures are kept for five minutes'. Below, one card whose top row carries the folder trail from 'Home' and, pushed right, a two-button segmented control 'One level' / 'Two levels'. A warning banner 'Some folders could not be measured'. Then a dense table with columns 'Folder' (folder icon plus linked name), 'Size' right aligned, and 'Share of this folder' drawn as a meter with a percentage beside it. Row '...' menu: 'Look inside', 'Open in file manager'. Card footer note about files counting towards the size but not being listed, with links to mail and public_html. Empty state 'No sub-folders yet.'
```

Sub-screens (1):

- **Two levels drill-down**

  ```text
  Drill-down view of the same table with 'Two levels' active in the segmented control: each top-level folder row is followed by its own children, indented one step under it and ordered largest first, each child keeping its size and share meter.
  ```

#### Directory privacy

`/panel/files/directory-privacy` · config

```text
Desktop account panel screen, 1440px. Page header 'Directory privacy', breadcrumb Home > Files > Directory privacy, favourite star, description 'Ask visitors for a username and password before a folder opens.' Header action: 'Refresh'. Body: card 'Folder', subtitle 'Protection covers the folder and everything below it.', holding an input group with a folder icon, a '~/' prefix, a path box and an 'Open' button, then a key and value list 'Folder', 'Served as' and 'Status' with a pill reading 'Password required' or 'Open to everyone'. Next, two cards side by side. 'Protection', subtitle 'Browsers show the name you give here in their sign-in prompt.', with a switch 'Ask for a username and password', a field 'Name shown in the prompt', buttons 'Save' and 'Reset', and the line 'Checked: the folder answered 401 (sign-in prompt)'. 'Add a user', subtitle 'Users belong to this folder; an existing name gets the new password.', with fields 'Username' and 'Password' and a button 'Add user'. Finally card 'Users', subtitle '2 of 200 users', with a dense table column 'Username' and row action 'Remove'; empty state 'No users yet. Add one above; passwords are stored hashed outside the website folder.' A closing note about the rules living in .htaccess.
```

Sub-screens (1):

- **Remove user confirmation**

  ```text
  Confirmation dialog 'Remove bob?' with the message 'They can no longer open the protected folder.' Buttons 'Cancel' and a red 'Remove user'.
  ```

#### Indexes

`/panel/files/indexes` · config

```text
Desktop account panel screen, 1440px. Page header 'Indexes', breadcrumb Home > Files > Indexes, favourite star, description 'Whether a folder without an index page lists its files.' Header action: 'Refresh'. Body: card 'Folder', subtitle 'Pick a folder of your website; the rule applies to it and to every folder below it that has no rule of its own.', with an input group carrying a folder icon, a '~/' prefix, a path box and an 'Open' button, followed by a key and value list 'Folder', 'Served as' and 'Rule' showing a status pill plus the aside 'no panel rules in this folder yet'. Then card 'Directory listing', subtitle 'What visitors see when they open a folder under ~/public_html that has no index.html or index.php.', holding a three-option radio list: 'Server default' with the description about inheriting from the parent, 'No indexing' describing a 403 Forbidden answer, and 'Show the file list' describing the visible listing. Buttons 'Save' and 'Reset', with the line 'Checked: the folder answered 403'. A closing note that the rule is an Options +/-Indexes line in .htaccess, linking to the file manager.
```

#### Git version control

`/panel/files/git` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Git version control', breadcrumb Home > Files > Git version control, favourite star, description 'Clone or create repositories under your home and deploy them to your sites.' Header actions: 'Refresh' and a primary 'New repository'. Body: card 'Your repositories', subtitle '2 of 10', with a table whose columns are 'Repository' (branch icon, name, and the folder path beneath), 'Remote' as code or 'none (local only)', 'Last pull', 'Last deploy', and 'State' with a pill reading 'ready' or 'folder missing'. Row '...' menu: 'Open', 'Pull', 'Deploy', 'Forget', 'Remove'. Beneath the table an information note listing repository folders that are not registered yet. Next, a repository detail card titled with the name and the folder as subtitle, its header carrying 'Pull', 'Check tasks', a primary 'Deploy' and a red 'Remove', and a key and value list 'Branch', 'Latest commit', 'Remotes', 'Uncommitted changes', 'Last pull', 'Last deploy', 'Deployment file' with a '.keel.yml found' pill, and 'Files' linking to the file manager. Last, card 'Deployment guide' with explanatory paragraphs and a code block of example tasks. Empty state 'Nothing deployed yet'.
```

Sub-screens (5):

- **New repository dialog**

  ```text
  Modal dialog 'New repository', medium. Fields in a grid: required 'Name' with helper about the folder under ~/repositories, 'Clone URL' with placeholder https://github.com/org/project.git, 'Folder' as an input group with a '~/' prefix, and 'Existing folder' holding a switch 'Use the existing folder'. Footer note 'Everything runs as your own account; no password is stored.' Buttons 'Cancel' and primary 'Clone'.
  ```

- **Job progress dialog**

  ```text
  Modal dialog 'Cloning my-site', large. A status pill, a progress bar with a percentage and a step message beside it, and a dark scrolling log pane of timestamped output lines. Single primary footer button 'Close'.
  ```

- **Deploy confirmation**

  ```text
  Confirmation dialog 'Deploy my-site?' with the message 'The tasks listed in .keel.yml run one by one as your account. Files they copy over are replaced; run "Check tasks" first to see the plan.' Buttons 'Cancel' and a primary 'Deploy'.
  ```

- **Remove repository confirmation**

  ```text
  Confirmation dialog 'Remove my-site?' with the message that the folder ~/repositories/my-site and everything in it is deleted, files a deployment copied elsewhere stay, and this cannot be undone. Buttons 'Cancel' and a red 'Remove repository'.
  ```

- **Forget repository confirmation**

  ```text
  Confirmation dialog 'Forget my-site?' with the message 'The repository disappears from this list; its folder and files stay in your account.' Buttons 'Cancel' and 'Forget'.
  ```

#### Web Disk

`/panel/files/webdisk` · config

```text
Desktop account panel screen, 1440px. Page header 'Web Disk', breadcrumb Home > Files > Web Disk, favourite star, description 'Open your home folder like a drive on your computer or phone over WebDAV.' No header actions. Body: card 'Web Disk', subtitle 'Open your home folder like a drive on your computer or phone: files you copy there land on the server at once.', with a key and value list 'Status' carrying a pill reading 'On', 'Web Disk address' as code, 'Login', 'Password' reading 'Set on 4 Mar 2026', and 'Service' naming the unit and its process id, followed by an explanatory line and a switch 'Enable Web Disk' with the description about running a small WebDAV service. Next, card 'Web Disk password', subtitle 'Devices sign in with your account name and this password.', with a read-only 'Login' box, a 'Web Disk password' field with a strength meter, an information note about connected devices having to sign in again, and a button 'Set Web Disk password'. Last, card 'Connect your devices' with a key and value list of address, login, server name and port 443, then five headed sections 'Windows', 'macOS', 'iPhone and iPad', 'Android' and 'Linux', each a short instruction paragraph.
```

Sub-screens (2):

- **Switch off confirmation**

  ```text
  Confirmation dialog 'Switch Web Disk off?' with the message 'Connected devices lose the disk until you switch it on again. Your files and your Web Disk password stay.' Buttons 'Cancel' and a red 'Switch off'.
  ```

- **Installing state**

  ```text
  The Web Disk card while the service is being installed: the status pill reads 'Starting', the line 'Web Disk is being set up on the server; this takes a minute the first time.' appears, the enable switch is disabled, and a progress log with a bar and streaming lines sits at the bottom of the card.
  ```

### 6. Email

12 screens. Sidebar tile colour for this category is used on its tool cards.

#### Email accounts

`/panel/email/accounts` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Email accounts', breadcrumb Home > Email > Email accounts, favourite star, description 'Mailboxes on your domains.'. Header actions: primary 'Create mailbox' button. Body: three stat tiles — 'Mailboxes' showing '3 of 10' over a meter, 'Domains with mail', 'Default quota'; optional warning banners 'Plan limit reached' and 'Mailboxes are not served yet'; then a full-width card holding a table with a 'Search addresses' box, an 'All domains' filter dropdown, and columns 'Address', 'Storage' (usage text over a small meter), 'Quota', 'Status' with Active and Suspended pills, and 'Created'. Each row has a '...' menu: 'Connect', 'Change password', 'Change quota', 'Suspend', 'Delete'. Empty state 'No mailboxes yet. Create one to receive mail at your domain; it appears here with its storage and status.' Muted footer note linking 'Forwarders' and 'Autoresponders'.
```

Sub-screens (6):

- **Create mailbox**

  ```text
  Modal dialog 'Create mailbox'. A required 'Address' row with a text box, an '@' separator and a domain dropdown, helper 'Lowercase letters, digits, dots, underscores and hyphens.'; a required 'Password' field with a generator hint; a 'Storage quota' number box with an 'MB' suffix and an 'Unlimited' switch. Buttons 'Cancel' and primary 'Create mailbox'.
  ```

- **Change password**

  ```text
  Small modal dialog 'Change password'. A sentence 'New password for name@example.com. Mail apps signed in with the old password stop syncing until they are updated.', then a required 'New password' field with a minimum-length and strength hint. Buttons 'Cancel' and primary 'Change password'.
  ```

- **Change quota**

  ```text
  Small modal dialog 'Change quota'. A line 'Storage for name@example.com — currently 240 MB in use.', a 'Storage quota' number field with an 'MB' suffix and an 'Unlimited' switch, and a warning line when the new quota is below what the mailbox holds. Buttons 'Cancel' and primary 'Save quota'.
  ```

- **Delete mailbox**

  ```text
  Small modal dialog 'Delete mailbox'. Text 'The mailbox name@example.com stops receiving mail and its login no longer works.', then a switch 'Also delete the stored messages' with the note that leaving it off keeps the messages on disk. Buttons 'Cancel' and a destructive 'Delete mailbox'.
  ```

- **Connect mailbox (client settings)**

  ```text
  Modal dialog 'Connect name@example.com'. Key and value list of 'Username', 'Password', 'Mail server' and 'Certificate'; a heading 'Incoming mail' with IMAP and POP3 host, port and security; a heading 'Outgoing mail' with SMTP, 'Ports' and 'Authentication'; warning banners about sending and port 25, and an 'Open webmail' link. One 'Close' button.
  ```

- **Suspend mailbox**

  ```text
  Confirmation dialog 'Suspend name@example.com?' with the message 'The mailbox keeps its messages but cannot sign in or receive mail until it is unsuspended.' Buttons 'Cancel' and a destructive 'Suspend'.
  ```

#### Forwarders

`/panel/email/forwarders` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Forwarders', breadcrumb Home > Email > Forwarders, favourite star, description 'Copy or redirect incoming mail to another address.'. Header actions: primary 'Add forwarder' button. Body: card 'Email forwarders' subtitled 'Send a copy of mail for one address somewhere else · up to 10 per domain.' holding a table with a 'Search addresses' box, an 'All domains' dropdown, and columns 'Address', 'Delivered to' (an address, or a pill reading 'Rejected with an error' or 'Discarded silently'), 'Created', with a row '...' menu holding 'Delete'; empty state 'No forwarders yet. Add one to send mail for an address at your domain on to another inbox.' Below, card 'Domain forwarders' with a table of 'Domain', 'Forwards to', 'Updated' and per-row 'Forward domain' or 'Change' and 'Stop' buttons. Muted footer note linking the default address.
```

Sub-screens (4):

- **Add forwarder**

  ```text
  Modal dialog 'Add forwarder'. A required 'Address' row with a text box, '@' and a domain dropdown; a 'What happens to the mail' radio group of 'Forward to another address', 'Reject with an error' and 'Discard silently', each with a line of explanation; when forwarding, a required 'Forward to' email field. Buttons 'Cancel' and primary 'Add forwarder'.
  ```

- **Forward a whole domain**

  ```text
  Small modal dialog 'Forward example.com'. A sentence explaining that every address at the domain reaches the same local part at the target, showing 'name@example.com' and 'name@example.org'; a required 'Target domain' text field. Buttons 'Cancel' and primary 'Save'.
  ```

- **Delete forwarder**

  ```text
  Confirmation dialog 'Delete the forwarder for sales@example.com?' with the message 'Mail for sales@example.com is no longer forwarded to someone@example.org. If no mailbox exists, the domain's default address applies.' Buttons 'Cancel' and a destructive 'Delete'.
  ```

- **Stop domain forwarding**

  ```text
  Confirmation dialog 'Stop forwarding example.com?' with the message 'Addresses at this domain are delivered to their own mailboxes and forwarders again.' Buttons 'Cancel' and a destructive 'Stop forwarding'.
  ```

#### Default address

`/panel/email/default-address` · config

```text
Desktop account panel screen, 1440px. Page header 'Default address', breadcrumb Home > Email > Default address, favourite star, description 'What happens to mail for addresses that do not exist.'. No header actions. Body: one card per domain on the account, titled with the domain name and subtitled 'What happens to mail for an address at this domain that has no mailbox or forwarder.', with a status pill in the card actions reading 'Reject with an error', 'Discard silently', 'Forward to an address' or 'Not set · rejects with an error'. Inside each card a radio group of three options, each with a line of explanation, and when 'Forward to an address' is chosen a required 'Deliver to' email field helped by 'A mailbox at one of your domains or any other address.'; a 'Save' button that stays disabled until something changes, with a 'Pending' pill beside it. When the account has no domains, a card reading 'No domains on this account yet.' Muted footer note linking 'Forwarders'.
```

#### Autoresponders

`/panel/email/autoresponders` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Autoresponders', breadcrumb Home > Email > Autoresponders, favourite star, description 'Automatic replies while you are away.'. Header actions: primary 'Create autoresponder' button. Body: one full-width card holding a table with columns 'Address', 'Subject' (the subject over a smaller 'from Jane at Example' line), 'Frequency' reading 'Once a day per sender', 'Schedule' reading 'now → until stopped' or a date range, and 'Status' with pills 'Active', 'Active until 3 May', 'Starts 1 May', 'Ended 7 May' or 'Stopped'. Each row has a '...' menu with 'Edit', 'Stop' or 'Start', and 'Delete'. Empty state: 'No autoresponders yet. Create one to answer every message to an address automatically, for example while you are away; it appears here with its schedule.'
```

Sub-screens (3):

- **Create autoresponder**

  ```text
  Large modal dialog 'Create autoresponder'. A required 'Address' row with text box, '@' and domain dropdown; side-by-side 'From name' and required 'Subject'; a required multi-line 'Message'; a 'Reply at most' number box with an 'hours apart' suffix; side-by-side 'Start' and 'Stop' date-and-time fields; an 'Enabled' switch. Buttons 'Cancel' and primary 'Create autoresponder'.
  ```

- **Edit autoresponder**

  ```text
  Large modal dialog 'Edit autoresponder for info@example.com'. The same form with a read-only 'Address' field, 'From name', 'Subject', 'Message', 'Reply at most … hours apart', 'Start', 'Stop' and an 'Enabled' switch. Buttons 'Cancel' and primary 'Save changes'.
  ```

- **Delete autoresponder**

  ```text
  Confirmation dialog 'Delete the autoresponder for info@example.com?' with the message 'The reply text is removed and no further automatic replies are sent.' Buttons 'Cancel' and a destructive 'Delete'.
  ```

#### Email filters

`/panel/email/filters` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Email filters', breadcrumb Home > Email > Email filters, favourite star, description 'Sort, forward or discard incoming mail per mailbox.'. Header actions: primary 'Create filter' button. Body: a card with a 'Mailbox' dropdown reading 'Choose a mailbox', helped by 'Filters belong to one mailbox; account-wide rules live under Account-wide filters.'; an information banner 'Filters of name@example.com, applied as mail arrives and after the account-wide filters.'; then a card with a table of columns '#', 'Filter' (the name over a plain-language rule summary such as 'Subject contains "invoice" → deliver to Archive') and 'Status' with Enabled and Disabled pills, each row a '...' menu of 'Edit', 'Disable', 'Move up', 'Move down', 'Delete'; last a card 'Generated script' with a 'Show' button and the line '2 of 3 filters enabled, 20 allowed.' A warning banner appears when the mail server lacks Sieve support.
```

Sub-screens (4):

- **Create filter**

  ```text
  Large modal dialog 'Create filter'. A required 'Name' field; a 'Conditions' group with an 'All conditions must match' dropdown and rows of field, operator and value boxes each with a remove button, plus 'Add condition'; an 'Actions' group of action dropdowns with folder or address boxes, plus 'Add action'; an 'Enabled' switch. Buttons 'Cancel', 'Test' and primary 'Create filter'.
  ```

- **Edit filter**

  ```text
  Large modal dialog 'Edit filter "Newsletters to Archive"'. The same name, conditions, actions and 'Enabled' switch, filled in. Buttons 'Cancel', 'Test' and primary 'Save changes'.
  ```

- **Test result inside the filter dialog**

  ```text
  Modal dialog state: inside the filter form a banner headed 'The filter compiles' or 'The filter does not compile', listing any 'Line 4: …' errors and showing the generated Sieve script in a read-only monospace box. Buttons stay 'Cancel', 'Test' and the primary save.
  ```

- **Delete filter**

  ```text
  Confirmation dialog 'Delete the filter "Newsletters to Archive"?' with the message 'Mail that matched it is delivered normally from now on.' Buttons 'Cancel' and a destructive 'Delete'.
  ```

#### Account-wide filters

`/panel/email/global-filters` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Account-wide filters', breadcrumb Home > Email > Account-wide filters, favourite star, description 'Rules that apply to every mailbox on this account.'. Header actions: primary 'Create filter' button. Body: an information banner 'These rules run for every mailbox on this account before the mailbox's own filters.'; a card with a table of columns '#', 'Filter' (the name over a one-line rule summary) and 'Status' with Enabled and Disabled pills, each row a '...' menu of 'Edit', 'Disable', 'Move up', 'Move down', 'Delete'; below it a card 'Generated script' subtitled 'The Sieve script the mail server runs for this scope.' with a 'Show' button and a count line. When nothing exists yet the whole body is one centred empty state titled 'Account-wide filters run before each mailbox's own filters' with explanatory text and a primary 'Create filter' button.
```

Sub-screens (3):

- **Create filter**

  ```text
  Large modal dialog 'Create filter'. A required 'Name' field; a 'Conditions' group with a match-mode dropdown and rows of field, operator and value boxes with remove buttons and 'Add condition'; an 'Actions' group of action dropdowns with folder or address boxes and 'Add action'; an 'Enabled' switch. Buttons 'Cancel', 'Test' and primary 'Create filter'.
  ```

- **Edit filter**

  ```text
  Large modal dialog 'Edit filter "Block spammer"'. Name, conditions, actions and the 'Enabled' switch filled in, with the compile result banner available. Buttons 'Cancel', 'Test' and primary 'Save changes'.
  ```

- **Delete filter**

  ```text
  Confirmation dialog 'Delete the filter "Block spammer"?' with the message 'Mail that matched it is delivered normally from now on.' Buttons 'Cancel' and a destructive 'Delete'.
  ```

#### Spam filters

`/panel/email/spam` · config

```text
Desktop account panel screen, 1440px. Page header 'Spam filters', breadcrumb Home > Email > Spam filters, favourite star, description 'Scoring thresholds, allow and block lists.'. No header actions. Body: card 'Filtering' subtitled 'Incoming mail is scored by SpamAssassin; anything at or above the threshold is marked as spam.' with an Enabled pill in its actions, a 'Filter spam' switch, a 'Spam threshold' number field helped by 'Balanced: the usual setting.', a 'Delete obvious spam' switch and a 'Delete at score' field. Two side-by-side cards 'Allow list' and 'Block list', each counting '0 of 200', with an email box, an 'Add' button and a list of addresses with remove crosses. Then 'Save spam settings', 'Discard changes' and 'Last saved 6 May'. Last, card 'How spam scoring works' with four paragraphs. Alternate state: a centred 'Spam filtering is not available on this server' with a 'Re-check' button.
```

#### Deliverability

`/panel/email/deliverability` · dashboard

```text
Desktop account panel screen, 1440px. Page header 'Deliverability', breadcrumb Home > Email > Deliverability, favourite star, description 'SPF, DKIM and DMARC records for your domains.'. Header actions: a domain dropdown. Body: a card titled with the domain, subtitled 'Checked 6 May', with 'Re-check' and 'Fix all (SPF, DMARC)' buttons; inside three stat tiles 'Deliverability score' showing 80 over 100 with a meter, 'Checks passing' reading '3 of 5' and 'DNS hosted here'; an information banner when the DNS is elsewhere; then a table with columns 'Check', 'Status', 'Published record', 'Suggested record' and an action column, rows SPF, DKIM, DMARC, MX and PTR with pills 'OK', 'Needs attention', 'Missing' or 'Unknown', a 'Signing' pill on DKIM, and 'Fix' or 'Copy record' buttons. Below, card 'DKIM signing key' with Domain, Selector, Generated and 'DNS hosted here' values and 'Generate key', 'Rotate key' and 'Remove key' buttons.
```

Sub-screens (4):

- **Create records**

  ```text
  Confirmation dialog 'Create the SPF, DMARC records?' with the message 'The suggested records are written into the DNS zone of example.com and published. An existing SPF or DMARC record is replaced; DKIM generates a key when none exists.' Buttons 'Cancel' and primary 'Fix'.
  ```

- **Prepare records (DNS elsewhere)**

  ```text
  Confirmation dialog 'Prepare the SPF record?' with the message 'DNS for example.com is managed at Cloudflare, so nothing is written here: the record is shown for you to add there. DKIM generates a key when none exists.' Buttons 'Cancel' and primary 'Prepare'.
  ```

- **Rotate DKIM key**

  ```text
  Confirmation dialog 'Rotate the DKIM key for example.com?' with the message 'A new key replaces the current one and the DNS record is updated. Mail signed with the old key may fail verification for a short while until caches expire.' Buttons 'Cancel' and primary 'Rotate key'.
  ```

- **Remove DKIM key**

  ```text
  Confirmation dialog 'Remove the DKIM key for example.com?' with the message 'Outgoing mail is no longer signed and the DNS record is removed. Receivers that require DKIM may reject your mail.' Buttons 'Cancel' and a destructive 'Remove key'.
  ```

#### Email routing

`/panel/email/routing` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Email routing', breadcrumb Home > Email > Email routing, favourite star, description 'Deliver mail for a domain here or at another mail server.'. Header actions: a 'Re-check MX' button. Body: one card titled 'Where mail for your domains is delivered', subtitled 'Each domain is delivered on this server unless you route it to a remote mail exchanger; the MX column shows what the public DNS says today.', holding a table with columns 'Domain' (name over 'main · 2 mailboxes'), 'Routing' (a dropdown of 'Automatic (deliver here)', 'Local mail exchanger (deliver here)' and 'Remote mail exchanger (another server)' with a line of help below it), 'Effective' with Local and Remote pills, 'Public MX' with pills 'Points here', 'Points elsewhere', 'No MX record' or 'Lookup failed', and a 'Save' button per row. Information banners sit under a row. Empty state 'No domains on this account yet'. Muted footer note linking the zone editor.
```

Sub-screens (1):

- **Route a domain remotely**

  ```text
  Confirmation dialog 'Route mail for example.com elsewhere?' with the message 'This server stops accepting mail for the domain and hands it to the public MX records. Forwarders, autoresponders and the default address of the domain stop working here.' Buttons 'Cancel' and primary 'Route remotely'.
  ```

#### Webmail

`/panel/email/webmail` · action

```text
Desktop account panel screen, 1440px. Page header 'Webmail', breadcrumb Home > Email > Webmail, favourite star, description 'Read your mail in the browser.'. No header actions. Body: card 'Open webmail' subtitled 'Read and send mail from any browser; you are signed in to your mailbox without entering its password.' with a primary 'Open webmail' button in the card actions and a key and value list of 'Address' (a link to the webmail URL), 'Application' reading 'roundcube 1.6.11', 'Mail server', 'Opens as' and 'Sign-in' explaining that the single sign-on link is valid for one minute. Below, card 'Your mailboxes' subtitled 'Open webmail for a specific mailbox.' with a table of 'Mailbox', 'Status' with Active and Suspended pills, and an 'Open' button per row. Alternate state: a centred 'Webmail is not set up on this server' with a 'Re-check' button.
```

#### Mail usage

`/panel/email/usage` · dashboard

```text
Desktop account panel screen, 1440px. Page header 'Mail usage', breadcrumb Home > Email > Mail usage, favourite star, description 'Messages sent and delivered recently.'. Header actions: a time-window dropdown showing 'Last 24 hours'. Body: a row of stat tiles 'Messages', 'Sent', 'Received', 'Delivered', 'Failed', 'Deferred', 'Queued' and 'Mailboxes' reading '2 of 10' with '1 GB allotted'; a muted log note. Two side-by-side cards: 'Per mailbox' with columns 'Mailbox', 'Sent', 'Received', 'Failed'; 'Per domain' with 'Domain', 'Delivered', 'Deferred', 'Failed'. Then card 'Messages' with a search box 'Address, subject or message id…', an 'Any status' dropdown, paging and columns 'Time', 'From', 'To', 'Subject', 'Size', 'Status' with delivered, failed, deferred and queued pills. Last, card 'Folders' with a mailbox dropdown and columns 'Folder', 'Messages', 'Unread', 'Size' and an 'Empty' or 'Delete old mail' button per row.
```

Sub-screens (2):

- **Empty a folder**

  ```text
  Small modal dialog 'Empty Trash?' with the text 'All 128 messages in Trash are deleted permanently. They cannot be recovered.' Buttons 'Cancel' and a destructive 'Empty folder'.
  ```

- **Delete old mail from a folder**

  ```text
  Small modal dialog 'Delete old mail from Archive?' with the text 'Messages in Archive saved before the age below are deleted permanently. The mail server keeps anything newer.', a required 'Older than (days)' number field helped by 'At least 7 days.' Buttons 'Cancel' and a destructive 'Delete'.
  ```

#### Calendars and contacts

`/panel/email/calendars` · config

```text
Desktop account panel screen, 1440px. Page header 'Calendars and contacts', breadcrumb Home > Email > Calendars and contacts, favourite star, description 'Sync calendars and address books with your phone and mail app over CalDAV and CardDAV.'. No header actions. Body: card 'Calendar server' with a primary 'Open web page' button and a key and value list of 'Status' (pill reading Ready, Not published, Stopped or Not available), 'Server address' as a link and 'DAV logins', plus an explanatory line when it is not ready. Card 'Set a DAV password' with a 'DAV login' dropdown, a 'DAV password' field and a 'Set DAV password' button. Card 'DAV logins' with a table of 'DAV login', 'Who', 'Status', 'Password set' and per-row 'Collections' and 'Remove' buttons. Card 'Set up your apps' listing the server address, your collections address, login and server name, then short instructions for Thunderbird, iPhone and iPad, Android and macOS.
```

Sub-screens (2):

- **Collections of a login**

  ```text
  Drawer-style drill-down card 'Collections of name@example.com', subtitled that these are the calendars and address books your apps created, with a 'Close' button and a table of 'Name', 'Type', 'Items' and 'Last change'. Empty state 'No collections yet' explaining the first app to connect creates them.
  ```

- **Remove DAV password**

  ```text
  Confirmation dialog 'Remove the DAV password?' with the message 'name@example.com can no longer sign in to the calendar server. Calendars and contacts stay on the server and come back with a new password.' Buttons 'Cancel' and a destructive 'Remove'.
  ```

### 7. Databases

5 screens. Sidebar tile colour for this category is used on its tool cards.

#### Databases

`/panel/databases/databases` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Databases', breadcrumb Home > Databases, favourite star, description 'Databases on this account.' Header action: button with a refresh icon 'Refresh'. Body: a card of three stat tiles, 'Databases' showing '3 of 10' with a meter and '7 more allowed by the plan', 'Database server' reading 'MariaDB' with 'Connect from your site with host localhost', and 'Name prefix' showing the prefix in monospace. Card 'Create a database', subtitle 'Choose a short name; the prefix is added for you.', with a prefixed name field 'Database name', a dropdown 'Character set', an optional 'Collation' field and a primary button 'Create database' beside the text 'Creates user_shop'. Card 'Databases' with a search box, subtitle '3 on this account', and a table: 'Database', 'Size', 'Tables', 'Users with access', 'Character set', 'Created', 'State' with pills 'ready' or 'missing on server'. Row menu: 'Check', 'Repair', 'Optimize', 'Download a backup', red 'Delete'.
```

Sub-screens (2):

- **Delete database confirmation**

  ```text
  Confirmation dialog 'Delete user_shop?' with the message 'Every table and all data in this database are deleted permanently. Type the database name to confirm.' and a text field in which the database name must be typed. Buttons 'Cancel' and red 'Delete database', disabled until the name matches.
  ```

- **Job progress dialog**

  ```text
  Modal dialog 'Check of user_shop', large width, showing a live scrolling log of the running job. For a backup it is titled 'Backup of user_shop' and adds a grey note that the SQL file is written to the backups folder, then an information note 'Saved as dump.sql (4.2 MB)' with a link to the file manager. Single button 'Close'.
  ```

#### Database users

`/panel/databases/users` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Database users', breadcrumb Home > Databases > Database users, favourite star, description 'Users and the privileges they hold on each database.' Header action: button with a refresh icon 'Refresh'. Body: card 'Create a database user', subtitle 'Sites connect with a user, not with your account password.', holding a prefixed name field 'User name' beside a 'Password' field with a strength meter and generator, then a field 'Give access to' rendered as a grid of checkboxes, one per database name in monospace, with help about granting all privileges; primary button 'Create user'. Card 'Database users', subtitle '4 on this account', with a search box and a table: 'User' in monospace, 'Allowed from' listing hosts, and 'Access' listing each database with its privileges in grey or an amber pill 'no database yet'. Row '…' menu: 'Privileges', 'Change password', red 'Delete'. Below, an information banner about connecting from localhost and a link to 'Remote hosts'.
```

Sub-screens (3):

- **Privileges of a user**

  ```text
  Modal dialog 'Privileges of user_app', large width. Grey intro explaining what the user may do on each database. A dense checkbox grid: rows are privileges with 'All privileges' first in bold, then ALTER, CREATE, DELETE, DROP, INSERT, SELECT, UPDATE and the rest; one right-aligned column per database name. Buttons 'Cancel', 'Remove all access' and primary 'Save privileges'.
  ```

- **Change password of a user**

  ```text
  Modal dialog 'Change password of user_app', small width. Required field 'New password' with a strength meter and generator, and a grey line 'Update the configuration of every site that signs in with this user afterwards.' Buttons 'Cancel' and primary 'Change password'.
  ```

- **Delete user confirmation**

  ```text
  Confirmation dialog 'Delete user user_app?' with the message 'The user and its privileges are removed. Websites and scripts that sign in with it will lose their database connection.' Buttons 'Cancel' and red 'Delete user'.
  ```

#### Remote hosts

`/panel/databases/remote-hosts` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Remote hosts', breadcrumb Home > Databases > Remote hosts, favourite star, description 'Hosts allowed to connect to your databases from outside.' Header action: button with a refresh icon 'Refresh'. Body: two cards side by side. Left, 'Allow a remote host', subtitle 'Lets a computer outside this server open your databases with your database users.', with a required field 'Host name or IP address' whose help explains the % wildcard, and a primary button 'Allow host'. Right, 'Connecting from outside', subtitle 'What to enter in a database client or an application running elsewhere.', a key-value list 'Server', 'Port', 'User', 'Password', 'Database' with monospace values and a grey note about the firewall. Below, full-width card 'Allowed hosts', subtitle '2 allowed', table with columns 'Host', 'Matches', 'Set by' (pills 'server-wide' or 'you'), 'Added', and a red 'Remove' in the row menu for editable rows.
```

Sub-screens (2):

- **Remove host confirmation**

  ```text
  Confirmation dialog 'Remove 203.0.113.5?' with the message 'Connections from this address are refused as soon as the change is applied. Connections from this server (localhost) keep working.' Buttons 'Cancel' and red 'Remove host'.
  ```

- **PostgreSQL unsupported state**

  ```text
  Alternate state of the 'Allow a remote host' card: a centred empty state with a globe icon titled 'Not available for this PostgreSQL server', explaining that remote access rules are written on the database server itself and to ask the hosting provider. The form and its button are gone; the table below reads 'Remote hosts cannot be managed for a PostgreSQL server on another machine.'
  ```

#### phpMyAdmin

`/panel/databases/phpmyadmin` · action

```text
Desktop account panel screen, 1440px. Page header 'phpMyAdmin', breadcrumb Home > Databases > phpMyAdmin, favourite star, description 'Open the database administration tool.' Header actions: primary button with an external-link icon 'Open phpMyAdmin' and a button with a refresh icon 'Refresh'. Body: two cards side by side. Left, 'How it works', subtitle 'A web interface for your databases: browse tables, run SQL, import and export.', a paragraph explaining phpMyAdmin opens in a new tab already signed in and the link is valid once, a grey note that the account password does not work there with a link to 'Database users', and a key-value list 'Status' with a pill reading 'available', 'Version', 'Address' as a link, and 'Sign-in' reading 'Single sign-on from this page'. Right, card 'Database users', subtitle about phpMyAdmin accepting any of these, holding a table with columns 'Database user' in monospace and a right-aligned 'Open' column of small 'phpMyAdmin' buttons. A grey footnote explains databases are named with the account prefix.
```

Sub-screens (2):

- **phpMyAdmin unavailable state**

  ```text
  Alternate state: the 'How it works' card shows a grey status pill reading 'not installed' or 'turned off by the provider' and an information note telling the customer to ask the hosting provider, with no address row. The header's 'Open phpMyAdmin' button is absent.
  ```

- **No database users state**

  ```text
  Alternate state of the right card: a centred empty state with a database icon titled 'No database users yet' and the text 'Create a user under Database users; it is listed here.', the words 'Database users' being a link. No table.
  ```

#### Database wizard

`/panel/databases/wizard` · wizard

```text
Desktop account panel screen, 1440px. Page header 'Database wizard', breadcrumb Home > Databases > Database wizard, favourite star, description 'Create a database, its user and the user's privileges in three steps.' Header action: button with a rotate icon 'Start over'. Body: a card holding a horizontal step indicator, three pills '1 Database', '2 User', '3 Privileges' separated by chevrons with the current one highlighted, and under it the grey line 'Three steps: the database, a user that signs in to it, and what that user may do. Each step is saved as you go, so you can leave after any of them.' Below, the step-one card 'Step 1: Create a database', subtitle 'Choose a short name; the prefix is added for you.', with a prefixed name field 'Database name' showing 'Will be created as user_shop', a dropdown 'Character set', and a primary button 'Next step' beside the text 'Creates user_shop'.
```

Sub-screens (3):

- **Step 2 of 3 — Create a database user**

  ```text
  Step 2 of 3. Card 'Step 2: Create a database user', subtitle 'Sites connect with a user, not with your account password.' An information note says the database is ready and the new user gets its privileges next. Prefixed field 'User name' beside 'Password' with a strength meter. Primary button 'Next step' and a grey link 'Skip: use an existing user instead'.
  ```

- **Step 3 of 3 — Privileges**

  ```text
  Step 3 of 3. Card 'Step 3: Privileges', subtitle 'What user_app may do on user_shop. All privileges is the usual choice for a site that owns its database.' A dense checkbox grid with one column for that database and rows 'All privileges' in bold then the individual privileges. Primary button 'Save privileges and finish'.
  ```

- **Finished summary**

  ```text
  Final state with all three step pills ticked. Card 'All set', subtitle 'Use these details in the configuration of your site.', a key-value list 'Database', 'User', 'Host' showing localhost, and 'Access' reading 'all privileges'. Grey note about the password not being shown again. Primary button 'Create another' and links 'Databases' and 'Database users'.
  ```

### 8. FTP

1 screens. Sidebar tile colour for this category is used on its tool cards.

#### FTP accounts

`/panel/ftp/accounts` · data-table

```text
Desktop account panel screen, 1440px. Page header 'FTP accounts', breadcrumb Home > FTP > FTP accounts, favourite star, description 'Extra logins limited to a folder of your account.' Header action: 'Refresh'. Body: two cards side by side. 'Connection settings', subtitle 'What every FTP client needs. Your main login has access to the whole account.', a label and value list of 'Server', 'Port', 'Encryption', 'Main login', 'Main password' and 'Extra logins', with a usage meter beneath. 'Create an FTP account', subtitle 'A login limited to one folder, for a designer, a developer or a device.', with fields 'Login' (input with a fixed suffix box), 'Password' with a strength meter, 'Folder' prefixed by the read-only home path, 'Space limit (MB)' placeholder 'Unlimited', and a primary 'Create FTP account' button. Below, full-width card 'FTP accounts' holding a searchable table, placeholder 'Search logins or folders', with columns 'Login', 'Folder', right-aligned 'Space limit', 'Created' and a row menu of 'Connection settings', 'Change password', 'Change space limit' and 'Delete'. Warning banners 'Plan limit reached' and 'Extra FTP logins are not enabled on this server'; empty state 'No extra FTP accounts yet.'
```

Sub-screens (4):

- **Connection settings modal**

  ```text
  Modal dialog titled 'Connection settings for designer@example.com' showing a label and value list of 'Server', 'Port', 'Protocol', 'Encryption', 'User name', 'Password', 'Folder' and 'Transfer mode', a note about importing through File › Import, and footer buttons 'FileZilla settings' and primary 'Done'.
  ```

- **Change password modal**

  ```text
  Small modal dialog titled 'Change password of designer@example.com' with a required password input 'New password' carrying a strength meter, the note 'Anyone using this login needs the new password from now on.', and footer buttons 'Cancel' and primary 'Change password'.
  ```

- **Change space limit modal**

  ```text
  Small modal dialog titled 'Space limit of designer@example.com' with a number input 'Space limit (MB)' placeholder 'Unlimited' helped by 'Empty means no limit beyond the account's disk space', and footer buttons 'Cancel' and primary 'Save limit'.
  ```

- **Delete FTP account confirmation**

  ```text
  Confirmation dialog titled 'Delete designer@example.com?' reading 'The login stops working immediately. The files in public_html stay where they are.' with buttons 'Cancel' and a destructive 'Delete FTP account'.
  ```

### 9. Cron

1 screens. Sidebar tile colour for this category is used on its tool cards.

#### Cron jobs

`/panel/cron/cron-jobs` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Cron jobs', breadcrumb Home > Cron > Cron jobs, favourite star, description 'Commands that run on a schedule.' Header action: 'Refresh'. Body: two cards side by side. 'Cron email', subtitle 'Whatever a job prints is mailed after each run; the subject names the command.', with an email input 'Send output to', a switch 'Do not send any mail' described as setting MAILTO empty, and a primary 'Save email' button. 'Add a cron job', subtitle 'Pick how often, then the command. It is saved to your crontab straight away.', with a 'Schedule' dropdown of 'Every minute', 'Every 5 minutes', 'Once an hour', 'Once a day (00:00)', 'When the server starts' and 'Custom…', a 'Command' input placeholder '/usr/bin/php ~/public_html/cron.php', and a primary 'Add cron job' button. Full-width card 'Cron jobs' with a destructive 'Remove crontab' action and a table of 'Runs' (a plain sentence over the raw expression) and 'Command', row menu 'Edit' and 'Delete'. Card 'Environment', subtitle 'Variables placed at the top of the crontab, available to every job.', listing each variable with a 'Remove' button plus 'Name' and 'Value' inputs and a 'Set variable' button. Empty state 'No cron jobs yet.'
```

Sub-screens (4):

- **Edit cron job modal**

  ```text
  Modal dialog titled 'Edit cron job' with a 'Schedule' dropdown of presets, the readable schedule and raw expression as help text, a 'Command' input, and footer buttons 'Cancel' and primary 'Save changes'.
  ```

- **Custom schedule fields**

  ```text
  Inside the schedule form, choosing 'Custom…' reveals five narrow inputs side by side labelled 'Minute', 'Hour', 'Day', 'Month' and 'Weekday' with the note 'Minute 0–59, hour 0–23, day 1–31, month 1–12, weekday 0–7'.
  ```

- **Delete cron job confirmation**

  ```text
  Confirmation dialog titled 'Delete this cron job?' showing the readable schedule and the command as its message, with buttons 'Cancel' and a destructive 'Delete'.
  ```

- **Remove crontab confirmation**

  ```text
  Confirmation dialog titled 'Remove the whole crontab?' reading that all jobs and every variable are deleted and nothing runs on a schedule afterwards, with a field to type 'remove' to confirm, buttons 'Cancel' and a destructive 'Remove crontab'.
  ```

### 10. Backups

2 screens. Sidebar tile colour for this category is used on its tool cards.

#### Backups

`/panel/backups/backups` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Backups', breadcrumb Home > Backups > Backups, favourite star, description 'Generate and download backups of your account.' Header action: 'Refresh'. Body: two cards side by side. 'Generate a backup', subtitle 'A compressed archive of the account, kept on the server until you delete it.', with two radio choices 'Home directory and mail' described as 'Your files and mailboxes. The quickest way to keep a copy of your site.' and 'Full account' described as 'Files, mailboxes, databases and DNS zones; large, but everything is in one archive.', and a primary 'Generate backup' button. 'What a backup contains', a label and value list of 'Home directory and mail', 'Full account', 'Kept where' and 'Backups on this account', with an information banner about downloading archives and a link to Restore. Full-width card 'Backups' with a searchable, paged table, placeholder 'Search archives', columns 'Archive', 'Contents', right-aligned 'Size', 'Status' with a pill reading 'ready', 'running', 'queued' or 'failed', and 'Created', row menu 'Download', 'Restore files' and 'Delete'. Empty state 'No backups yet.'
```

Sub-screens (3):

- **Backup running progress**

  ```text
  Inside the 'Generate a backup' card, a streaming progress log panel with a status line 'A full account backup is running' and a small 'Hide progress' button beneath it; the 'Generate backup' button is disabled while it runs.
  ```

- **Delete backup confirmation**

  ```text
  Confirmation dialog titled 'Delete backup-2026-11-07.tar.gz?' reading 'The archive is removed from the server. Download it first if you want to keep a copy.' with buttons 'Cancel' and a destructive 'Delete backup'.
  ```

- **Read-only impersonation banner**

  ```text
  Information banner at the top of the page headed 'Read-only while logged in as example' reading 'Backups can be generated and restored by the account user only; the list and downloads are available.', with the generate and delete controls disabled.
  ```

#### Restore

`/panel/backups/restore` · explorer

```text
Desktop account panel screen, 1440px. Page header 'Restore', breadcrumb Home > Backups > Restore, favourite star, description 'Put files back from a backup or an uploaded archive.' Header action: 'Refresh'. Body: two cards side by side. 'Restore from a backup', subtitle 'Pick an archive, walk into it and choose what to put back.', with an 'Archive' dropdown placeholder 'Choose an archive', an 'Options' switch 'Replace existing files' described as 'Off: only files missing from the account are restored. On: the archive's copy wins.', and a primary 'Restore 3 selected' button. 'Upload an archive', subtitle 'A backup downloaded from this panel earlier. It is verified and listed as a restore source.', with a 'Choose an archive' button, the chosen file name and size, and a primary 'Upload archive' button. Full-width card 'Inside backup.tar.gz' with a folder breadcrumb in its header and a dense, tickable table of 'Name', 'Type', right-aligned 'Files', right-aligned 'Size' and 'Modified'. Card 'Restore history', subtitle 'Restores started from this panel.', a dense table of 'Restore', 'Archive', 'Scope', right-aligned 'Items', 'Status', 'Result', 'Started' and 'Finished'.
```

Sub-screens (5):

- **Restore confirmation**

  ```text
  Confirmation dialog titled 'Restore 3 items from backup.tar.gz?' reading 'Files that exist on the account with the same names are replaced by the copies in the archive.' with buttons 'Cancel' and a destructive 'Restore'.
  ```

- **Archive folder drill-down**

  ```text
  The contents card after walking into a folder: breadcrumb buttons 'home › public_html › css', tickable rows of folder buttons and monospace file names with 'Folder' or 'File', file counts, sizes and modified dates, and a footer line '3 selected: public_html/css'.
  ```

- **Upload in progress**

  ```text
  The 'Upload an archive' card while sending: a full-width progress meter, the line '12 MB of 40 MB sent · verifying the archive', a loading primary 'Upload archive' button and a 'Cancel' button beside it.
  ```

- **No archive chosen empty state**

  ```text
  The contents card titled 'Archive contents' showing a folder icon, heading 'Choose an archive to browse', text 'The folders and files inside it appear here. Tick what you want back and press Restore.' and a muted line offering to generate a backup.
  ```

- **SSH keys excluded note**

  ```text
  A small muted note under the archive table reading 'SSH keys are managed under Security › SSH keys and are not restored here', with the matching rows shown untickable and marked '· managed under Security › SSH keys'.
  ```

### 11. Logs

4 screens. Sidebar tile colour for this category is used on its tool cards.

#### Access logs

`/panel/logs/access-logs` · viewer

```text
Desktop account panel screen, 1440px. Page header 'Access logs', breadcrumb Home > Logs > Access logs, favourite star, description 'Web server access and error logs for your domains.' Header actions: a 'Refresh' button. Body: two cards side by side. 'Choose a log', subtitle 'Raw web server logs for the domains on this account.', with dropdowns 'Web server', 'Domain' (placeholder 'All domains'), 'Log file', 'Show' ('Last 64 KB') and a 'Follow' switch labelled 'Refresh every 5 seconds', then buttons 'Reload view' and 'Download'. 'Log retention' with switches 'Archive logs monthly' and 'Remove old archives' over a list 'Last archived' and 'Archive folder'. Below, a full-width card 'Tail of access.log' with a line count on the right and the log text in a monospace block. Last card 'Log files' with a dense table 'File', 'Domain', 'Location', 'Size', 'Updated' and row actions 'View' and 'Download'.
```

Sub-screens (3):

- **Nothing selected state**

  ```text
  Alternate state of the log view card: an empty state titled 'Nothing selected' with the text 'Choose a domain and a log file above. The last part of the file shows here and can be followed live.' and a muted line that the web server writes the first lines when a visitor arrives.
  ```

- **Web server missing state**

  ```text
  Alternate state at the top of the body: a card-surfaced notice saying NGINX is not installed on this server so there are no NGINX logs to show, with a retry button, while the 'Choose a log' pickers stay visible and the log view and file list cards are hidden.
  ```

- **Skipped locations banner**

  ```text
  Alternate state: a warning banner above the cards titled 'Some log locations were skipped' listing the skipped paths as bullet points, with everything else on the page unchanged.
  ```

#### Bandwidth

`/panel/logs/bandwidth` · dashboard

```text
Desktop account panel screen, 1440px. Page header 'Bandwidth', breadcrumb Home > Logs > Bandwidth, favourite star, description 'Traffic per month against your plan.' Header actions: a 'Refresh' button. Body: four stat tiles — the current month name with its transferred figure, a sub-line '34% of 50 GB' and a usage meter; 'Monthly limit' with 'Set by your hosting plan'; 'Busiest month shown' with the month underneath; 'Total shown' with a month count. Card 'Traffic per month', subtitle 'Measured from the web server logs.', with a range dropdown 'Last 12 months' in its header and a dense table 'Month' (the current month in bold), right-aligned 'Transferred', and 'Of the monthly limit' drawn as a meter with a percentage. Card 'How traffic is counted' listing each log path with the bytes processed and when it was last read.
```

Sub-screens (1):

- **Nothing recorded state**

  ```text
  Alternate state: the traffic table shows the empty text 'No traffic recorded yet. Figures appear here after the first hour of visits to your domains.' and the 'How traffic is counted' card shows the empty state 'No logs read yet' explaining the hourly scan.
  ```

#### Visitors

`/panel/logs/visitors` · dashboard

```text
Desktop account panel screen, 1440px. Page header 'Visitors', breadcrumb Home > Logs > Visitors, favourite star, description 'Who visits your sites: visitors, pages, referrers and the full report.' Header actions: a 'Refresh' button. Body: card 'Domain' with a domain dropdown, a 'Last generated' date and a primary 'Generate now' button in its header. Four stat tiles 'Unique visitors', 'Requests', 'Transferred', 'Not found'. Then two side-by-side pairs of dense tables — 'Top pages', 'Referring sites', then 'Not found' and 'Countries' — each with a first column 'Page', 'Site', 'Address' or 'Country' plus right-aligned 'Hits', 'Visitors', 'Transferred'. Card 'Visitors per day' with 'Day', 'Visitors', 'Hits', 'Transferred'. Card 'Full report' with 'Open full report' and 'New tab' buttons. Card 'All domains' with 'Domain', 'Last generated', 'Visitors', 'Requests', 'Transferred', 'State' pills.
```

Sub-screens (3):

- **Full report opened**

  ```text
  Drill-down view of the 'Full report' card with the button switched to 'Hide report': the card body is filled edge to edge by a tall embedded report frame about three quarters of the viewport high, showing the complete visitor statistics page.
  ```

- **No report for this domain**

  ```text
  Alternate state: a card holding the empty state 'No report yet for example.com' with the text that the nightly run skips domains without visitors and an instruction to press 'Generate now' once the site has had traffic. The stat tiles and all the table cards are absent.
  ```

- **Generating state**

  ```text
  Alternate state of the 'Domain' card: the primary button reads 'Generating…' and is disabled, the 'Last generated' value carries the suffix 'generating now', and the 'All domains' table shows that row's state pill reading 'Generating'.
  ```

#### Errors

`/panel/logs/errors` · viewer

```text
Desktop account panel screen, 1440px. Page header 'Errors', breadcrumb Home > Logs > Errors, favourite star, description 'The newest lines of every error log of your domains.' Header actions: a 'Refresh' button. Body: card 'What to show', subtitle 'The newest lines of every error log of your domains, newest first.', holding a three-column field row — dropdown 'Domain' with placeholder 'All domains', dropdown 'Show' reading 'Last 300 lines', and a 'Follow' switch labelled 'Refresh every 10 seconds' with the note 'Keeps the view current while you reproduce a problem'. Below it one card per log file, titled with the file name, subtitled with the domain, Apache or NGINX, the location, the size and 'updated <date>', a muted line count on the right, and the log lines in a monospace block.
```

Sub-screens (2):

- **No error logs state**

  ```text
  Alternate state: a single card with the empty state 'No error logs yet' and the text 'The web server creates an error log per domain the first time something goes wrong, such as a missing page or a PHP error.' The per-file cards are absent.
  ```

- **Empty log card**

  ```text
  Alternate state of one log card: instead of log lines, an empty state 'This log is empty' with the text 'Nothing has gone wrong on this domain since the log was created.' The card title, subtitle and line count stay.
  ```

### 12. PHP

2 screens. Sidebar tile colour for this category is used on its tool cards.

#### PHP versions

`/panel/php/versions` · data-table

```text
Desktop account panel screen, 1440px. Page header 'PHP versions', breadcrumb Home > PHP > PHP versions, favourite star, description 'The PHP version each domain runs.' Header action: 'PHP settings'. Body: card 'Available versions', subtitle 'Offered by the server administrator and available to your domains.', a table of 'Version', 'Release', 'Your domains' and 'Status', the status cell holding pills 'server default', 'recommended' and 'security advisory'. Card 'Set all domains', subtitle 'One version for every domain of your account; change a single domain below afterwards.', with a 'PHP version for all domains' dropdown and a primary 'Apply to 4 domains' button. Card 'Domains', subtitle 'Each domain can run its own version; the server default applies otherwise.', a searchable table, placeholder 'Search domains…', with columns 'Domain' (name plus a 'main', 'addon' or 'subdomain' pill), 'Document root' in monospace, 'Runs' and 'PHP version' holding a dropdown of 'Server default' plus each version and a 'Save' button that appears once changed. Card 'How it works' listing 'Server default', 'Plan default', 'Recommended' and 'Per-domain settings'. Empty state 'No web domains yet'.
```

Sub-screens (1):

- **Apply to all domains confirmation**

  ```text
  Confirmation dialog titled 'Set all 4 domains to PHP 8.3?' reading 'Every one of your web domains (main, addon and subdomains) is switched; each domain can be changed again on its own afterwards.' with buttons 'Cancel' and 'Apply to all'.
  ```

#### PHP settings

`/panel/php/ini` · config

```text
Desktop account panel screen, 1440px. Page header 'PHP settings', breadcrumb Home > PHP > PHP settings, favourite star, description 'Per-domain .user.ini directives.' Header action: 'PHP versions'. Body: card 'Domain', subtitle 'Settings live in the .user.ini file of the domain's document root and apply to that domain only.', with a dropdown 'Edit settings for' listing each domain with its type and PHP version, and a 'File' block showing the file path in monospace with an 'exists' or 'not created yet' pill and the note that PHP re-reads the file within about five minutes. Card 'Common directives', subtitle 'Leave a value empty to use the server default.', with a two-tab segmented control 'Common' and 'All directives' in its header, and a grid of labelled fields named after directives such as 'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'display_errors', 'date.timezone' and 'allow_url_fopen', booleans as dropdowns of 'Not set (server default)', 'On' and 'Off', each with one line of help and a 'changed' pill. A sticky action bar holds a primary 'Save', a 'Reset' and the line '2 directives changed'. Card 'Current file', subtitle 'What is in the file right now, before your changes.', showing the file as preformatted log output. Empty state 'No web domains yet'.
```

Sub-screens (1):

- **All directives view**

  ```text
  The same card retitled 'All directives', subtitle 'Every directive in the file, including ones not in the common list.', showing a table of 'Directive' in monospace, an editable 'Value' input and a small destructive remove button per row, then a directive name input, a value input and an 'Add' button beneath it.
  ```

### 13. Security

7 screens. Sidebar tile colour for this category is used on its tool cards.

#### Password

`/panel/security/password` · form

```text
Desktop account panel screen, 1440px. Page header 'Password', breadcrumb Home > Security > Password, favourite star, description 'Change the password for this account.' No header actions. Body: a warning banner 'A new password is required' with the text about the hosting provider asking for a change before the rest of the panel can be used. Then two cards side by side. 'Change password', subtitle 'The password for alice: panel sign-in, FTP main login and, where enabled, SSH.', with required fields 'Current password', 'New password' carrying a strength meter and the helper 'At least 8 characters; mix letters, digits and symbols', and 'Repeat new password', then a primary button 'Change password' with the aside 'Changed'. 'Where this password is used' with a key and value list 'Account panel' reading 'Signing in here', 'FTP main login' as code, 'SSH' with a pill reading 'not enabled', and 'Server login' reading 'Kept in sync', closing on a blue information banner about mailbox, FTP and database users having their own passwords and other sessions being signed out. An informational banner also appears when an administrator is viewing the account, reading 'Read-only while logged in as alice'.
```

#### Two-factor authentication

`/panel/security/two-factor` · config

```text
Desktop account panel screen, 1440px. Page header 'Two-factor authentication', breadcrumb Home > Security > Two-factor authentication, favourite star, description 'Protect sign-in with a one-time code.' No header actions. Body: a warning banner 'Two-factor authentication is required on this server' with the line 'Set it up below to use the rest of the account panel.' Then two cards side by side. 'Your sign-in', subtitle 'A one-time code from an authenticator app protects the alice login.', with a key and value list 'Status' carrying a pill reading 'Enabled', 'Enrollment started' or 'Not enabled', and 'Policy' reading 'Required for account users'; below it either a primary button 'Set up two-factor authentication' or a red 'Disable'. During enrolment the card instead shows an explanatory paragraph, a centred QR code, a key and value list 'Secret key' with a copy button, 'Account' and 'Type' reading 'Time-based (TOTP), 6 digits, 30 seconds', the setup link, a six-digit 'Verification code' box, and buttons 'Enable' and 'Cancel'. The second card 'How it works' lists 'At sign-in', 'Recovery codes', 'API tokens' and 'Administrators' with their explanations.
```

Sub-screens (2):

- **Disable confirmation**

  ```text
  Confirmation dialog 'Disable two-factor authentication?' with the message 'Sign-in goes back to password only. You can set it up again at any time.' Buttons 'Cancel' and a red 'Continue'.
  ```

- **Confirm identity dialog**

  ```text
  Modal dialog 'Confirm it is you', small. An explanatory line that turning the second factor off needs the current password or a code from the authenticator app, then fields 'Current password' and 'Or a 6-digit code'. Buttons 'Cancel' and a red 'Disable'.
  ```

#### SSH keys

`/panel/security/ssh-keys` · data-table

```text
Desktop account panel screen, 1440px. Page header 'SSH keys', breadcrumb Home > Security > SSH keys, favourite star, description 'Public keys allowed to open a shell on this account.' Header action: 'Refresh'. Body: two cards side by side. 'Authorise a public key', subtitle 'Paste the public half of a key pair; its owner can then sign in over SSH without a password.', with a required four-row monospaced 'Public key' textarea, placeholder text beginning ssh-ed25519, helper 'The contents of id_ed25519.pub or id_rsa.pub, one line', and a primary button 'Authorise key'. 'Connecting' with a key and value list 'Host', 'User', 'Shell access' reading 'Enabled', 'Command' showing an ssh command and 'Make a key pair' showing an ssh-keygen command, plus a note that keys are kept in ~/.ssh/authorized_keys. Below, card 'Authorised keys', subtitle '2 keys can open a shell', with a dense table of columns 'Name', 'Type', 'Fingerprint' and 'Options' and a row action 'Remove'. Empty states: 'No keys authorised yet. Paste a public key above' and a 'No home directory yet' block. Closing note that only key lines are listed.
```

Sub-screens (1):

- **Remove key confirmation**

  ```text
  Confirmation dialog 'Remove you@laptop?' with the message 'Whoever holds the matching private key can no longer open a shell on this account.' Buttons 'Cancel' and a red 'Remove key'.
  ```

#### Sessions

`/panel/security/sessions` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Sessions', breadcrumb Home > Security > Sessions, favourite star, description 'Where this account is signed in.' Header action: 'Refresh'. Body: two cards side by side. 'This sign-in', subtitle 'The browser you are using now.', with a key and value list 'Login' as code, 'Account', 'Server', 'Two-factor' carrying a pill reading 'not enabled', and 'Logged in as' reading 'alice by root, ends in 42 min'. 'Sign out everywhere else', subtitle 'Lost a laptop, or used a shared computer? End every other session of this login.', with the paragraph about browsers being signed out immediately and API tokens being unaffected, and a red button 'Sign out other sessions'. Below, card 'Active sessions', subtitle '2 sessions signed in as this login', with a dense table of columns 'Session' as code, 'Expires', 'Time left' right aligned, and 'Status' with a pill reading 'signed in' or 'expiring'. Empty state 'No sessions found. Your own sign-in appears here with the time it expires.' Closing note that sessions expire on their own.
```

Sub-screens (1):

- **Sign out confirmation**

  ```text
  Confirmation dialog 'Sign out everywhere else?' with the message 'Every other browser signed in as alice is signed out now; this one stays signed in.' Buttons 'Cancel' and a red 'Sign out other sessions'.
  ```

#### API tokens

`/panel/security/tokens` · data-table

```text
Desktop account panel screen, 1440px. Page header 'API tokens', breadcrumb Home > Security > API tokens, favourite star, description 'Tokens for scripts that use the panel API.' Header actions: 'Refresh' and a primary 'Create token'. Body: a warning banner 'Two-factor authentication is needed before tokens can be issued' with a 'Set it up' link. Then card 'API tokens', subtitle '2 tokens for alice', with a search box 'Search tokens' and a dense table of columns 'Name' in bold, 'Starts with' as truncated code, 'Scopes' drawn as small grey pills, 'Expires' showing a date or 'Never' or an 'expired' pill, 'Last used' and 'Created'. Row action 'Revoke'. Empty state 'No API tokens yet. Create one to let a script or tool work with this account; it appears here with its scopes, expiry and last use.' Below, card 'Using a token' with a key and value list 'Header' showing an Authorization Bearer line, 'Base URL', 'Example' showing a curl command, 'Scopes', and 'Not possible with a token' reading 'Changing the password, the second factor, SSH keys or other tokens'.
```

Sub-screens (3):

- **Create token dialog**

  ```text
  Modal dialog 'Create an API token', medium. Required 'Name' field with placeholder 'Deploy script on build server', then a required 'Scopes' checkbox list of seven rows, each a bold label with its code and a smaller description: 'Read everything', 'Files', 'Email', 'DNS', 'Databases', 'Backups', 'Cron'. Finally an 'Expires' date and time field. Buttons 'Cancel' and primary 'Create token'.
  ```

- **Copy new token dialog**

  ```text
  Modal dialog 'Copy your new token', medium. A warning banner 'Shown once' with the line about only a hash being kept. A read-only monospaced input holding the token with a 'Copy' button beside it, then a key and value list 'Scopes' and 'Expires'. Single primary button 'I have saved it'.
  ```

- **Revoke token confirmation**

  ```text
  Confirmation dialog 'Revoke Deploy script?' with the message 'Scripts using this token stop working immediately. This cannot be undone; create a new token instead.' Buttons 'Cancel' and a red 'Revoke token'.
  ```

#### IP blocker

`/panel/security/ip-blocker` · data-table

```text
Desktop account panel screen, 1440px. Page header 'IP blocker', breadcrumb Home > Security > IP blocker, favourite star, description 'Keep addresses and ranges away from your sites.' Header action: 'Refresh'. Body: two cards side by side. 'Block an address', subtitle 'Requests from a blocked address get a 403 on every site of this account.', with a required field 'IP address or range', placeholder 203.0.113.0/24, helper 'An address such as 203.0.113.9, or a range in CIDR form', and a primary button 'Block'. 'How it works' with a key and value list 'Where' showing the .htaccess path, 'Applies to' naming the domain, 'Response' reading 'HTTP 403 Forbidden', 'Your address', and 'Last check' reading 'The site answered 403 after the change', plus a note about the panel keeping its rules between BEGIN and END markers. Below, card 'Blocked addresses', subtitle '3 of 500 entries', with a dense table of columns 'Address or range' as code and 'Kind' reading 'IPv4 range · /24'. Row action 'Unblock'. Empty state 'Nothing is blocked. Add an address or a range above; it takes effect on the next request.' Closing note on CIDR notation.
```

Sub-screens (1):

- **Unblock confirmation**

  ```text
  Confirmation dialog 'Unblock 203.0.113.0/24?' with the message 'Visitors from this address can reach your sites again straight away.' Buttons 'Cancel' and a red 'Unblock'.
  ```

#### Virus scanner

`/panel/security/virus-scanner` · action

```text
Desktop account panel screen, 1440px. Page header 'Virus scanner', breadcrumb Home > Security > Virus scanner, favourite star, description 'Scan your files, mail and websites for malware.' Header action: 'Refresh'. Body: card 'Start a scan', subtitle 'ClamAV reads your files as your own account and reports anything that matches a known signature. Nothing is changed by the scan itself.', holding the small line 'ClamAV 1.5.4, signatures updated within the hour', an information note 'A scan is already running.' with a small 'Follow it' button, a dropdown 'What to scan' offering 'Entire home directory', 'Mail (mail/)' and 'Websites (public_html/)' with the helper about a full home scan stopping after fifteen minutes, and a primary button 'Scan now'. Below, card 'Recent scans' with a table of columns 'When', 'Scope', 'Result' carrying a pill reading 'clean', '2 infected' or 'failed', and 'Duration'. Row action 'View'. Empty state 'No scan has run yet.' Another note reads 'The virus scanner is not installed on this server. Ask your hosting provider.'
```

Sub-screens (3):

- **Scan progress dialog**

  ```text
  Modal dialog 'Scanning Websites (public_html/)', large. A status pill, a progress bar with a percentage, and a dark streaming log pane. When it finishes, an information note '2 infected file(s). Delete what you do not recognise', a table of 'File' and 'Signature' with a red pill per row and a 'Delete' row action, and a red button 'Delete all infected files'. Footer button 'Close'.
  ```

- **Past scan result dialog**

  ```text
  Modal dialog 'Scan of Websites (public_html/)', large. A key and value list 'Result', 'When' and, when present, 'Error'. Below it a table of infected files with columns 'File' and 'Signature' and a 'Delete' row action, and the line '3 file(s) could not be read and were skipped.' Footer button 'Close'.
  ```

- **Delete infected confirmation**

  ```text
  Confirmation dialog 'Delete 2 infected file(s)?' with the message 'The files are removed from your account. If a website needs one of them, restore it from a backup instead. This cannot be undone.' Buttons 'Cancel' and a red 'Delete'.
  ```

### 14. Usage

1 screens. Sidebar tile colour for this category is used on its tool cards.

#### Usage

`/panel/usage/usage` · dashboard

```text
Desktop account panel screen, 1440px. Page header 'Usage', breadcrumb Home > Usage > Usage, favourite star, description 'Disk, bandwidth and object counts against your plan.' Header action: 'Refresh figures'. Body: an information banner 'Disk figures are from a scan 3 hours ago' with the measured date. A row of three large stat tiles 'Disk space', 'Bandwidth this month' and 'Files (inodes)', each a value, an 'of 10 GB' sub-line, a meter and a source note such as 'From the file system quota'. Card 'What your plan includes', subtitle 'How much of each allowance is in use.', with stat tiles 'Addon domains', 'Subdomains', 'Parked domains', 'Mailboxes', 'Databases' and 'FTP accounts', each reading 'of 10', 'unlimited' or 'none in plan'. Two cards side by side: 'Where the space goes', a table of 'Folder', right-aligned 'Size' and 'Share' as a bar, with a 'Total' footer row; 'Bandwidth by month', a table of 'Month', right-aligned 'Transferred' and 'Relative'. Card 'Plan limits' listing 'Disk space', 'Bandwidth per month', 'Domains', 'Outgoing mail per hour', 'Files (inodes)', 'Home directory' and 'Figures last refreshed'.
```

Sub-screens (2):

- **Disk scan in progress**

  ```text
  Card titled 'Scanning disk usage' with a 'Close' button in its header and a running job progress panel inside reading 'Disk scan started; the figures update in a minute.'
  ```

- **No scan yet empty state**

  ```text
  The 'Where the space goes' card showing a hard-drive icon, heading 'No scan yet', text 'A folder-by-folder breakdown appears after the first disk scan.' and the muted hint 'Use "Refresh figures" to start one now.'
  ```

### 15. Advanced

4 screens. Sidebar tile colour for this category is used on its tool cards.

#### Error pages

`/panel/advanced/error-pages` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Error pages', breadcrumb Home > Advanced > Error pages, favourite star, description 'Your own pages for 404 and the other error responses.' Header actions: a 'Refresh' button. Body: card 'Domain', subtitle 'Each site has its own error pages, stored in its errors/ folder.', with an 'Error pages for' dropdown and a read-only 'Folder' value showing a monospace path ending in /errors/. Card 'Error responses' holding a dense table with columns 'Code' in monospace, 'Response' showing the status name in bold over a one-line explanation, 'Page' as a status pill reading 'Server default', 'Custom page', 'Your own file' or 'File present, not used', and 'Title'. Row '...' menu: 'Edit' or 'Create', and a red 'Use default'. Footnote that pages are plain HTML with your text only.
```

Sub-screens (3):

- **Edit error page dialog**

  ```text
  Modal dialog titled '404 · Not found' with a text field 'Heading' helped by 'Leave empty for the standard wording.' and a six-row textarea 'Message' helped by 'Plain text; a blank line starts a new paragraph.' Footer buttons 'Cancel' and a primary 'Save page'.
  ```

- **Use default confirmation**

  ```text
  Confirmation dialog 'Use the server's default 404 page?' with the message 'errors/404.html is deleted and the ErrorDocument line removed from .htaccess.' Buttons 'Cancel' and a red 'Remove page'.
  ```

- **No web domains state**

  ```text
  Alternate state: under the 'Domain' card, a card holding the empty state 'No web domains yet' with the text 'Error pages appear here once the account has a domain.' The 'Error responses' card is absent.
  ```

#### Optimize website

`/panel/advanced/optimize-website` · config

```text
Desktop account panel screen, 1440px. Page header 'Optimize website', breadcrumb Home > Advanced > Optimize website, favourite star, description 'Compress pages, styles and scripts before they are sent to visitors.' Header actions: a 'Refresh' button. Body: card 'Folder', subtitle 'Compression is set per folder and applies to everything below it; public_html covers your whole main site.', with an inline path input prefixed by a folder icon and '~/' plus an 'Open' button, then a key/value list 'Folder', 'Served as' and 'Compression' with a status pill. Card 'Compression (gzip)', subtitle 'Browsers that accept compressed responses get them; others get the file as it is.', with three stacked radio options and descriptions — 'Disabled', 'Compress all content', 'Compress the selected types' — and buttons 'Save' and 'Reset'. Footnote about the .htaccess rule with a file manager link.
```

Sub-screens (2):

- **Custom content types state**

  ```text
  Alternate state of the 'Compression (gzip)' card with 'Compress the selected types' chosen: under the radio list, three checkbox fieldsets side by side legended 'Pages and feeds', 'Styles, scripts and SVG' and 'Fonts', each listing content types in monospace, above the 'Save' and 'Reset' buttons.
  ```

- **Saved with probe result**

  ```text
  Alternate state of the action row after saving: beside the 'Save' and 'Reset' buttons a muted line reading 'Checked: the site answered 200', or the alternative 'The site could not be probed' with the reason in brackets.
  ```

#### Hotlink protection

`/panel/advanced/hotlink-protection` · config

```text
Desktop account panel screen, 1440px. Page header 'Hotlink protection', breadcrumb Home > Advanced > Hotlink protection, favourite star, description 'Stop other sites from embedding your images and files.' Header actions: a 'Refresh' button. Body: card 'Status', subtitle explaining that hotlinking is another website embedding your files and using your bandwidth, with a key/value list 'Protection' as an On or Off pill, 'Your domains (always allowed)' as monospace chips and 'Folder', then a switch 'Block hotlinking'. Card 'Rules' with a field 'Other sites allowed to embed your files' holding a text input and an 'Add' button above removable host chips, a switch 'Allow direct requests', a checkbox fieldset 'Protected file types' grouped as 'Images', 'Audio and video', 'Documents and archives', a text field 'Send blocked requests to', and 'Save' and 'Reset' buttons.
```

Sub-screens (2):

- **Protection off state**

  ```text
  Alternate state with the 'Block hotlinking' switch off: the 'Protection' pill reads 'Off' and every control in the 'Rules' card — host input, 'Add' button, chips, 'Allow direct requests' switch, file type checkboxes and redirect field — is greyed out and disabled.
  ```

- **Redirect validation error**

  ```text
  Alternate state of the 'Send blocked requests to' field showing an inline error under the input reading 'The address must not be one of the protected file types, or it would be blocked too', with the 'Save' button disabled.
  ```

#### Terminal

`/panel/advanced/terminal` · viewer

```text
Desktop account panel screen, 1440px. Page header 'Terminal', breadcrumb Home > Advanced > Terminal, favourite star, description 'A command line on your account, in the browser.' Header actions: 'Reconnect' and 'Disconnect' buttons. Body: one card titled 'Shell', subtitled 'Session 4f2a9c1b as testuser', with a status pill reading 'Connected' in its header. The card body is filled by a dark monospace terminal area roughly 480 pixels tall showing a shell prompt, a couple of commands and their output, and a blinking cursor. Under the terminal two muted paragraphs: the copy and paste hint naming Ctrl+Shift+C and Ctrl+Shift+V with a small 'Copy selection' button inline, and a line saying a shell closes after 15 minutes without activity and after 4 hours at most, and that opens and closes are recorded.
```

Sub-screens (2):

- **Shell not in plan state**

  ```text
  Alternate whole-page state: the header carries no action buttons and the body is one card with an empty state titled 'Not included in your plan', the line 'Shell access is not included in your plan, so the terminal cannot be opened.' and a muted suggestion to ask the hosting provider about upgrading.
  ```

- **Disconnected state**

  ```text
  Alternate state of the 'Shell' card: the status pill reads 'Disconnected', the subtitle reads 'No shell is open.', the terminal area ends with a dim bracketed line 'The shell has ended.', the same sentence appears as a muted paragraph below, and 'Disconnect' is disabled.
  ```

### 16. Software

4 screens. Sidebar tile colour for this category is used on its tool cards.

#### WordPress

`/panel/software/wordpress` · catalog

```text
Desktop account panel screen, 1440px. Page header 'WordPress', breadcrumb Home > Software > WordPress, favourite star, description 'Install, update and remove WordPress on your domains.' Header actions: a segmented control 'WordPress', 'Joomla', 'Drupal' with WordPress active, and a 'Refresh' button. Body: card 'Install WordPress', subtitle 'A fresh copy of the current release, with its own database, on one of your domains.', with a two-column field grid 'Domain' dropdown, 'Folder' text input helped by 'Leave empty to install at the domain itself, or give a folder such as blog', 'Site title', 'Administrator user name', 'Administrator e-mail' and 'Administrator password' holding a 'Generate one for me' switch, then a primary 'Install WordPress' button beside a muted note about the method and the database. Card 'Your WordPress sites' with a table 'Site', 'Version', 'Database', 'State' and a row menu.
```

Sub-screens (4):

- **Install progress dialog**

  ```text
  Large modal dialog 'Installing WordPress at example.com/blog' with a warning banner 'Write down the administrator password now; it is not shown again.' listing 'User name', 'Password' with a copy button and 'Sign-in page' as a link, then a scrolling progress log and a 'Close' footer button.
  ```

- **Update confirmation**

  ```text
  Confirmation dialog 'Update example.com/blog?' with the message that WordPress core is updated to the latest release with WP-CLI, extensions and themes are left alone, back up first and the site is briefly in maintenance mode. Buttons 'Cancel' and 'Update'.
  ```

- **Remove site dialog**

  ```text
  Small modal dialog 'Remove example.com/blog?' explaining that the folder and everything in it is deleted and this cannot be undone, with a switch 'Also delete the database wp_blog' described as holding every post, page and setting. Footer buttons 'Cancel' and a red 'Remove WordPress'.
  ```

- **No sites state**

  ```text
  Alternate state of the 'Your WordPress sites' card: the table shows only the empty text 'No WordPress installation found. Install one above, or upload your own: anything with a wp-config.php under your document roots is listed here.'
  ```

#### Installers

`/panel/software/installers` · catalog

```text
Desktop account panel screen, 1440px. Page header 'Installers', breadcrumb Home > Software > Installers, favourite star, description 'One-click WordPress, Joomla and Drupal on your domains.' Header actions: a segmented control 'WordPress', 'Joomla', 'Drupal' that switches the whole page, and a 'Refresh' button. Body for the Joomla tab: card 'Install Joomla', subtitle 'A fresh copy of the current release, with its own database, on one of your domains.', with fields 'Domain', 'Folder', 'Site title', 'Administrator user name', 'Administrator e-mail' and 'Administrator password' with a 'Generate one for me' switch, then a primary 'Install Joomla' button and a note that it is downloaded from downloads.joomla.org, checked against its published checksum, and the database is created for you. Card 'Your Joomla sites' with a table 'Site', 'Version', 'Database', 'State'.
```

Sub-screens (5):

- **Drupal tab**

  ```text
  Alternate state with the 'Drupal' tab active: the install card shows only 'Domain' and 'Folder' fields plus an information note that the site name, language and administrator are chosen in the Drupal installer, which opens once the files and the database are in place.
  ```

- **Finish setup state**

  ```text
  Alternate state of the sites table: a row whose 'State' pill reads 'setup pending' and whose '...' menu leads with 'Finish setup', followed by 'Open admin' and a red 'Remove'.
  ```

- **Install progress dialog**

  ```text
  Large modal dialog 'Installing Joomla at example.com/shop' with a warning banner holding the generated administrator user name, password with a copy button and the sign-in link, a scrolling progress log underneath, and a 'Close' footer button.
  ```

- **Remove site dialog**

  ```text
  Small modal dialog 'Remove example.com/shop?' saying the folder and everything in it is deleted and this cannot be undone, with a switch 'Also delete the database'. Footer buttons 'Cancel' and a red 'Remove Joomla'.
  ```

- **Cannot install notice**

  ```text
  Alternate state inside the install card: an information note reading 'Joomla cannot be installed on this server yet.' followed by a hint or 'Ask your hosting provider.', with every field in the form greyed out and the install button disabled.
  ```

#### Plugins

`/panel/software/plugins` · catalog

```text
Desktop account panel screen, 1440px. Page header 'Plugins', breadcrumb Home > Software > Plugins, favourite star, description 'Extra tools your hosting provider installed for your account.' Header actions: a small 'Refresh' button. Body: one card per installed plugin, each titled with the plugin's display name and subtitled with its identifier and version, holding a plain unspaced list of the pages that plugin offers for account holders — the page title as a link, followed by a muted dash and the page description. No tables, no forms, no stat tiles. Several such cards stack down the page.
```

Sub-screens (1):

- **No plugin pages state**

  ```text
  Alternate whole-body state: one card with the empty state 'No plugin pages', the line 'Your hosting provider has not installed any plugin with a page for account holders.' and a muted sentence explaining that pages added by plugins open inside the account panel and only see this account.
  ```

#### Application manager

`/panel/software/apps` · data-table

```text
Desktop account panel screen, 1440px. Page header 'Application manager', breadcrumb Home > Software > Application manager, favourite star, description 'Run Node.js and Python applications as services and publish them on your domains.' Header actions: a 'Refresh' button. Body: card 'Add an application', subtitle about uploading your program to a folder of your home directory first, with a two-column field grid 'Name', 'Type', 'Folder', 'Start file', 'Runtime', 'Domain', 'Path', a 'WebSockets' switch labelled 'Forward WebSocket connections too' and a monospace 'Environment variables' textarea, then a primary 'Add application' button beside a port-range note. Card 'Your applications' with a table 'Application' (name over its path in monospace), 'Runtime', 'Address' (link over the port), 'Status' as a pill with PID and memory beneath, and a row menu 'Stop' or 'Start', 'Restart', 'Logs', 'Install dependencies', 'Edit', 'Remove'.
```

Sub-screens (5):

- **Application logs dialog**

  ```text
  Large modal dialog 'Logs of my-app' showing the service output in a monospace block filling the body, or the muted line 'Nothing logged yet.' Footer buttons 'Refresh' and a primary 'Close'.
  ```

- **Install dependencies dialog**

  ```text
  Large modal dialog 'Installing the dependencies of my-app' with a muted line explaining that npm install --omit=dev runs in the application folder as your account, then a live scrolling progress log. Footer button 'Close'.
  ```

- **Edit application dialog**

  ```text
  Large modal dialog 'Edit my-app' with a read-only 'Port' and 'Service' pair at the top, then fields 'Folder', 'Start file', 'Runtime', 'Domain', 'Path', a 'WebSockets' switch and an 'Environment variables' textarea. Footer buttons 'Cancel' and 'Save and restart'.
  ```

- **Remove application confirmation**

  ```text
  Confirmation dialog 'Remove my-app?' with the message that the service is stopped and removed, example.com/app no longer forwards to it, and the files in the folder stay. Buttons 'Cancel' and a red 'Remove'.
  ```

- **No applications state**

  ```text
  Alternate state of the 'Your applications' card: the table shows only the empty text 'No application yet. Add one above: a Node.js or Python program that listens on the PORT variable.'
  ```

### 17. Preferences

1 screens. Sidebar tile colour for this category is used on its tool cards.

#### User manager

`/panel/preferences/users` · data-table

```text
Desktop account panel screen, 1440px. Page header 'User manager', breadcrumb Home > Preferences > User manager, favourite star, description 'People who use this account's services with their own login: a mailbox, an FTP folder, calendars.' Header actions: 'Refresh' and a primary 'Add user'. Body: an information banner saying the plan allows a number of users and all of them exist. Card 'Users', subtitle 'People who use this account's services with their own login: a mailbox, an FTP folder, calendars. They never sign in to this panel.', holding a searchable table, placeholder 'Search users', with columns 'User' (the login in monospace over the full name), 'Services' (pills 'Email', 'FTP' and 'Calendars'), 'Contact' and 'Created', and a row menu of 'Edit', 'Change password' and 'Delete user'. A closing note points to 'Email accounts' and 'FTP accounts'. Empty state heading 'No users yet' with the text 'Add a user to give someone a mailbox and an FTP folder with one password, and switch services on or off later.'
```

Sub-screens (4):

- **Add a user modal**

  ```text
  Modal dialog titled 'Add a user' with 'User name' as an input, an '@' separator and a domain dropdown, 'Full name', 'Contact email', a 'Services' heading with switches 'Email', 'FTP' and 'Calendars and contacts', a required 'Password' with a strength meter, and footer buttons 'Cancel' and primary 'Create user'.
  ```

- **Edit user modal**

  ```text
  Modal dialog titled 'Edit jane@example.com' without the name and domain fields, showing 'Full name', 'Contact email', the three service switches with 'Mailbox size (MB)' and 'Folder' revealed when Email or FTP is on, a 'Password' field helped by 'Leave empty to keep the current password', and footer buttons 'Cancel' and primary 'Save'.
  ```

- **Change password modal**

  ```text
  Small modal dialog titled 'Change password of jane@example.com' with a required 'New password' input and strength meter, the note 'Applies to: Email, FTP. Anyone using this login needs the new password from now on.', and footer buttons 'Cancel' and primary 'Change password'.
  ```

- **Delete user confirmation**

  ```text
  Confirmation dialog titled 'Delete jane@example.com?' reading 'Its services (Email, FTP) are removed with it, including the mailbox and its messages.' with buttons 'Cancel' and a destructive 'Delete user'.
  ```

