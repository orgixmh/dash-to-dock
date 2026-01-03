// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Gio,
    GLib,
    GObject,
    Pango,
    St,
} from './dependencies/gi.js';

import {
    BoxPointer,
    Main,
    PopupMenu,
} from './dependencies/shell/ui.js';

import {
    Extension,
    Utils,
} from './imports.js';

const {gettext: __} = Extension;

const FILE_ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::type',
    'standard::content-type',
    'standard::icon',
    'access::can-execute',
].join(',');

const ITEM_ICON_SIZE = 48;
const MONITOR_DEBOUNCE_MS = 250;

/*
 * Design note: Folder stacks are persisted in the extension's GSettings schema
 * under the "folder-stacks" key (array of folder URIs). Dash items are
 * represented by those URI strings, which the DockDash turns into
 * FolderStackItem instances. The popup keeps a stack of Gio.File instances to
 * implement folder navigation (Back button pops the stack).
 */

const FolderStackPopup = GObject.registerClass(
class FolderStackPopup extends PopupMenu.PopupMenu {
    _init(sourceActor, rootFile) {
        super._init(sourceActor, 0.5, Utils.getPosition());

        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._rootFile = rootFile;
        this._pathStack = [];
        this._currentFile = null;
        this._refreshTimeoutId = 0;

        this.actor.add_style_class_name('folder-stack-popup');
        this.blockSourceEvents = true;

        this._section = new PopupMenu.PopupMenuSection();
        this.addMenuItem(this._section);

        this._content = new St.BoxLayout({
            vertical: true,
            style_class: 'folder-stack-popup-content',
        });

        this._header = new St.BoxLayout({
            style_class: 'folder-stack-popup-header',
        });

        this._backButton = new St.Button({
            style_class: 'folder-stack-back-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        this._backButton.set_child(new St.Icon({
            icon_name: 'go-previous-symbolic',
            style_class: 'popup-menu-icon',
        }));
        this._backButton.connect('clicked', () => this._navigateBack());

        this._headerLabel = new St.Label({
            style_class: 'folder-stack-popup-title',
            x_expand: true,
        });
        this._headerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._header.add_child(this._backButton);
        this._header.add_child(this._headerLabel);

        this._scrollView = new St.ScrollView({
            style_class: 'folder-stack-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });

        this._grid = new St.Widget({
            style_class: 'folder-stack-grid',
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_spacing: 12,
                row_spacing: 12,
            }),
        });
        this._scrollView.set_child(this._grid);

        this._content.add_child(this._header);
        this._content.add_child(this._scrollView);
        this._section.actor.add_child(this._content);

        this.actor.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.uiGroup.add_child(this.actor);
        sourceActor.connect('destroy', () => this.destroy());

        this._setDirectory(rootFile, {reset: true});
    }

    destroy() {
        this._clearMonitor();
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = 0;
        }
        this._signalsHandler.destroy();
        super.destroy();
    }

    _setDirectory(file, {reset = false, push = true} = {}) {
        if (reset)
            this._pathStack = [file];
        else if (push)
            this._pathStack.push(file);

        this._currentFile = file;
        const basename = file.get_basename();
        this._headerLabel.text = basename || file.get_uri();
        const atRoot = this._pathStack.length <= 1;
        this._backButton.visible = !atRoot;
        this._backButton.reactive = !atRoot;

        this._refreshContents();
        this._monitorDirectory(file);
    }

    _navigateBack() {
        if (this._pathStack.length <= 1)
            return;

        this._pathStack.pop();
        const file = this._pathStack[this._pathStack.length - 1];
        this._currentFile = null;
        this._setDirectory(file, {push: false});
    }

    _refreshContents() {
        this._grid.get_children().forEach(child => child.destroy());

        const entries = this._listDirectory(this._currentFile);
        entries.forEach(entry => {
            const item = this._createEntryItem(entry);
            this._grid.add_child(item);
        });
    }

    _listDirectory(file) {
        if (!file)
            return [];

        let enumerator;
        try {
            // TODO: consider async enumeration for very large folders.
            enumerator = file.enumerate_children(FILE_ATTRIBUTES,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (error) {
            return [];
        }

        const entries = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const child = file.get_child(info.get_name());
            entries.push({
                file: child,
                info,
            });
        }
        enumerator.close(null);

        entries.sort((a, b) => {
            const typeA = a.info.get_file_type() === Gio.FileType.DIRECTORY ? 0 : 1;
            const typeB = b.info.get_file_type() === Gio.FileType.DIRECTORY ? 0 : 1;
            if (typeA !== typeB)
                return typeA - typeB;
            const nameA = a.info.get_display_name() || a.info.get_name();
            const nameB = b.info.get_display_name() || b.info.get_name();
            return nameA.localeCompare(nameB);
        });

        return entries;
    }

    _createEntryItem({file, info}) {
        const button = new St.Button({
            style_class: 'folder-stack-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        const content = new St.BoxLayout({
            vertical: true,
            style_class: 'folder-stack-item-content',
        });

        const icon = new St.Icon({
            gicon: info.get_icon(),
            icon_size: ITEM_ICON_SIZE,
            style_class: 'folder-stack-item-icon',
        });
        const label = new St.Label({
            text: info.get_display_name() || info.get_name(),
            style_class: 'folder-stack-item-label',
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        content.add_child(icon);
        content.add_child(label);
        button.set_child(content);

        button.connect('clicked', () => this._activateEntry(file, info));
        return button;
    }

    _activateEntry(file, info) {
        const fileType = info.get_file_type();
        if (fileType === Gio.FileType.DIRECTORY) {
            this._setDirectory(file);
            return;
        }

        const uri = file.get_uri();
        if (this._launchDesktopFile(file, info) ||
            this._launchExecutable(file, info)) {
            this.close();
            return;
        }

        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context());
        } catch (error) {
            global.notify_error(__('Failed to open “%s”').format(info.get_display_name()));
        }
        this.close();
    }

    _launchDesktopFile(file, info) {
        if (info.get_content_type() !== 'application/x-desktop')
            return false;

        const path = file.get_path();
        if (!path)
            return false;

        const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
        if (!appInfo)
            return false;

        try {
            appInfo.launch([], global.create_app_launch_context());
        } catch (error) {
            global.notify_error(__('Failed to launch “%s”').format(info.get_display_name()));
        }
        return true;
    }

    _launchExecutable(file, info) {
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            return false;

        if (!info.get_attribute_boolean('access::can-execute'))
            return false;

        const uri = file.get_uri();
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context());
        } catch (error) {
            global.notify_error(__('Failed to launch “%s”').format(info.get_display_name()));
        }
        return true;
    }

    _monitorDirectory(file) {
        this._clearMonitor();

        try {
            this._monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch (error) {
            this._monitor = null;
            return;
        }

        this._monitorChangedId = this._monitor.connect('changed', () => {
            if (!this.isOpen)
                return;

            if (this._refreshTimeoutId)
                GLib.source_remove(this._refreshTimeoutId);

            this._refreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                MONITOR_DEBOUNCE_MS, () => {
                    this._refreshTimeoutId = 0;
                    this._refreshContents();
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    _clearMonitor() {
        if (this._monitor) {
            if (this._monitorChangedId) {
                this._monitor.disconnect(this._monitorChangedId);
                this._monitorChangedId = 0;
            }
            this._monitor.cancel();
            this._monitor = null;
        }
    }
});

export const FolderStackItem = GObject.registerClass({
    Signals: {
        'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class FolderStackItem extends St.Button {
    _init(uri, iconSize) {
        super._init({
            style_class: 'app-well-app folder-stack-icon',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this.folderStackUri = uri;
        this._delegate = this;
        this._file = Gio.File.new_for_uri(uri);

        this._iconActor = new St.Icon({
            style_class: 'folder-stack-icon-image',
        });
        this.icon = new St.Bin({
            child: this._iconActor,
        });
        this.icon.icon = this._iconActor;
        this.icon.setIconSize = size => {
            this._iconActor.icon_size = size;
        };

        this.icon.setIconSize(iconSize);
        this.set_child(this.icon);

        this._updateDisplayInfo();

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._popup = new FolderStackPopup(this, this._file);
        this._menuManager.addMenu(this._popup);

        this.connect('clicked', () => {
            if (this._popup.isOpen)
                this._popup.close();
            else
                this._popup.open(BoxPointer.PopupAnimation.FULL);
        });

        this._signalsHandler.add(this._popup, 'open-state-changed',
            (_menu, isOpen) => this.emit('menu-state-changed', isOpen));

        this.connect('destroy', () => this._onDestroy());
    }

    setIconSize(size) {
        this.icon.setIconSize(size);
    }

    _updateDisplayInfo() {
        try {
            const info = this._file.query_info('standard::icon,standard::display-name',
                Gio.FileQueryInfoFlags.NONE, null);
            const displayName = info.get_display_name() || info.get_name();
            this._iconActor.gicon = info.get_icon();
            this.name = displayName;
            this.accessible_name = displayName;
        } catch (error) {
            this._iconActor.gicon = new Gio.ThemedIcon({name: 'folder'});
            this.name = this.folderStackUri;
            this.accessible_name = this.folderStackUri;
        }
    }

    _onDestroy() {
        this._signalsHandler.destroy();
        this._menuManager.removeMenu(this._popup);
        this._menuManager.destroy();
        this._popup.destroy();
    }
});

export function extractFolderUrisFromDropSource(source) {
    if (!source)
        return [];

    const uris = [];
    if (typeof source.uri === 'string')
        uris.push(source.uri);
    if (Array.isArray(source.uris))
        uris.push(...source.uris);
    if (Array.isArray(source.dragInfo?.uris))
        uris.push(...source.dragInfo.uris);
    if (typeof source.get_uri === 'function')
        uris.push(source.get_uri());

    if (typeof source.dragInfo?.get_data === 'function') {
        const data = source.dragInfo.get_data('text/uri-list');
        if (data) {
            const lines = data.split('\n').map(line => line.trim());
            lines.forEach(line => {
                if (line && !line.startsWith('#'))
                    uris.push(line);
            });
        }
    }

    return [...new Set(uris)].filter(Boolean);
}
