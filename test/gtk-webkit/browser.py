#!/usr/bin/env python3

import os
import sys

os.environ["WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"] = "1"

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2


class BrowserWindow(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app)
        self.set_default_size(600, 600)
        self.set_title("GTK3 WebKit 4.1 😀")

        webview = WebKit2.WebView()
        page = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
        with open(page, encoding="utf-8") as file:
            content = file.read()

        argument = sys.argv[1] if len(sys.argv) > 1 else ""
        webview.load_html(content, "file:///app/share/index.html?arg=" + argument)

        scrolled_window = Gtk.ScrolledWindow()
        scrolled_window.add(webview)
        scrolled_window.show_all()
        self.add(scrolled_window)

        header = Gtk.HeaderBar()
        header.set_title("GTK3 WebKit 4.1 😀")
        header.set_show_close_button(True)
        self.set_titlebar(header)

        button = Gtk.Button(label="Open in browser")
        button.connect("clicked", self.on_button_clicked)
        header.pack_end(button)
        header.show_all()
        self.webview = webview

    def on_button_clicked(self, _button):
        import subprocess

        subprocess.Popen(["xdg-open", self.webview.get_uri()])


class BrowserApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="com.drjohn.AnciGtk")

    def do_activate(self):
        self.window = BrowserWindow(self)
        self.window.present()


BrowserApp().run()
