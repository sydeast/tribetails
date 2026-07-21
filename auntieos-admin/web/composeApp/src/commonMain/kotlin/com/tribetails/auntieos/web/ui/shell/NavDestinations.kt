package com.tribetails.auntieos.web.ui.shell

import androidx.compose.ui.graphics.vector.ImageVector
import com.composables.icons.lucide.Activity
import com.composables.icons.lucide.CalendarDays
import com.composables.icons.lucide.CalendarPlus
import com.composables.icons.lucide.ClipboardList
import com.composables.icons.lucide.House
import com.composables.icons.lucide.Inbox
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MessageCircle
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Receipt
import com.composables.icons.lucide.Settings
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.Users
import com.composables.icons.lucide.BookOpen
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.Flag

/**
 * Single source of truth for AuntieOS desktop nav. Order here is the order shown
 * in the side rail / bottom dock.
 *
 * Grouping follows the Den redesign (ui-ideas/auntieos-redesign-2026-05-27.html):
 * a curated primary rail of "The Den" + "Care Ops", with the admin/system surface
 * the concept mockup omitted collected under "More" (so nothing is unreachable).
 */
enum class Destination(
    val title: String,
    val icon: ImageVector,
    val group: NavGroup,
) {
    // The Den
    Home        ("Home",              Lucide.House,         NavGroup.Den),
    Directory   ("Directory",         Lucide.Users,         NavGroup.Den),
    KinTales    ("KinTales",          Lucide.ClipboardList, NavGroup.Den),
    // #13 global Gallery: all KinTale media in one place, pinned in the rail (the
    // entity-scoped MediaGallery below stays contextual).
    Gallery     ("Gallery",           Lucide.Images,        NavGroup.Den),
    // Care Ops
    Schedule    ("Schedule",          Lucide.CalendarDays,  NavGroup.CareOps),
    Bookings    ("Bookings",          Lucide.CalendarPlus,  NavGroup.CareOps),
    Sessions    ("Auntie Time",       Lucide.PawPrint,      NavGroup.CareOps),
    Invoices    ("Invoices",          Lucide.Receipt,       NavGroup.CareOps),
    // #11: standalone Payments screen removed; payment info lives on the paid
    // invoice's detail (record-payment + the per-invoice Payments panel).
    Communicate ("Communicate",       Lucide.MessageCircle, NavGroup.CareOps),
    // More (admin / system)
    Inbox       ("Inbox",             Lucide.Inbox,         NavGroup.More),
    Notifications ("Notifications",     Lucide.Bell,          NavGroup.More),
    Activity    ("Activity Log",      Lucide.Activity,      NavGroup.More),
    Settings    ("Settings",          Lucide.Settings,      NavGroup.More),
    TrainingDocs ("Tribal Intel",      Lucide.BookOpen,      NavGroup.More),
    // Template Bank + Assignment merged into one two-tab destination (Decision 2).
    Templates     ("Templates",         Lucide.Mail,          NavGroup.More),
    FormSchemas   ("Form Schemas",      Lucide.ClipboardList, NavGroup.More),
    FeatureFlags  ("Feature Flags",     Lucide.Flag,          NavGroup.More),
    MediaGallery ("Media",             Lucide.Images,        NavGroup.More),
    // Operator's own account (punch list #4). Contextual: reached via the account
    // chip, never pinned in the rail (filtered out like MediaGallery).
    AccountSettings ("Account",        Lucide.Settings,      NavGroup.More),
    // Operator's OWN notification receive-prefs (what reaches them, and how). Contextual:
    // opened from the account screen, never pinned in the rail (filtered out like Account).
    MyNotifications ("My notifications", Lucide.Bell,          NavGroup.More);
}

enum class NavGroup(val label: String) {
    Den    ("The Den"),
    CareOps("Care Ops"),
    More   ("More"),
}

/**
 * 17.4 Nav editor: the destinations the editor can reorder / rename / hide (the rail
 * set; MediaGallery is reached contextually, not pinned in the rail). Their [Destination.name]
 * values are the keys stored in UserProfile.navConfig.
 */
val navEditableDestinations: List<Destination> =
    Destination.entries.filter {
        it != Destination.MediaGallery && it != Destination.AccountSettings && it != Destination.MyNotifications
    }

/** 17.4: resolve a navConfig key back to its [Destination] (null if unknown / removed). */
fun destinationByName(name: String): Destination? =
    Destination.entries.firstOrNull { it.name == name }
