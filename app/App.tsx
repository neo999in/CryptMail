import { createDrawerNavigator } from '@react-navigation/drawer';
import { createNavigationContainerRef, DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { InboxDrawerParamList, RootStackParamList } from './src/navigation';
import { ComposeScreen } from './src/screens/ComposeScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { CategoryDrawer } from './src/screens/CategoryDrawer';
import { KeysScreen } from './src/screens/KeysScreen';
import { CannedRepliesScreen } from './src/screens/CannedRepliesScreen';
import { LabelsScreen } from './src/screens/LabelsScreen';
import { RuleEditScreen } from './src/screens/RuleEditScreen';
import { RulesScreen } from './src/screens/RulesScreen';
import { MessageScreen } from './src/screens/MessageScreen';
import { RecoveryScreen } from './src/screens/RecoveryScreen';
import { AccountScreen } from './src/screens/AccountScreen';
import { AccountsScreen } from './src/screens/AccountsScreen';
import { AppearanceScreen } from './src/screens/AppearanceScreen';
import { MailScreen } from './src/screens/MailScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { SwipeGlyphDemoScreen } from './src/screens/SwipeGlyphDemoScreen';
import { SwipeOptionsScreen } from './src/screens/SwipeOptionsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SetupScreen } from './src/screens/SetupScreen';
import { AppProvider, useApp } from './src/state/AppState';
import { drillOutstanding } from './src/store/recoveryStore';
import { color, defaultAccent, font } from './src/theme';
import { AppBackground } from './src/ui/AppBackground';
import { AppearanceProvider, useAccent } from './src/ui/appearance';
import { CannedRepliesProvider } from './src/ui/cannedReplies';
import { MailPrefsProvider } from './src/ui/mailPrefs';
import { ChromeProvider } from './src/ui/chrome';
import { DialogHost } from './src/ui/dialog';
import { DestinationProvider } from './src/ui/destination';
import { NotificationRouter } from './src/ui/notificationRouter';
import { ToastProvider } from './src/ui/ToastContext';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Drawer = createDrawerNavigator<InboxDrawerParamList>();
/** For the one thing that navigates from outside a screen: a tapped notification. */
const navigationRef = createNavigationContainerRef<RootStackParamList>();

// On web, Microsoft sign-in redirects its popup back to this app; this hands
// the redirect to the window that opened it and closes the popup. A no-op on
// native, where the browser returns to the app through the `cryptmail` scheme.
WebBrowser.maybeCompleteAuthSession();

// Transparent surfaces everywhere so the app's single ground colour shows
// through every screen.
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: 'transparent',
    card: 'transparent',
    border: color.lineSoft,
    text: color.ink,
    primary: defaultAccent,
    notification: color.coral,
  },
};

const screenOptions = {
  // The header stays transparent so it merges into the black ground instead of
  // sitting on it as a near-black bar. There is no separator to lose:
  // `headerShadowVisible` is already off.
  headerStyle: { backgroundColor: 'transparent' },
  headerTintColor: color.ink,
  headerTitleStyle: { fontFamily: font.sansSemibold, fontSize: 17 },
  headerShadowVisible: false,
  // The screen body is painted the same true black as `AppBackground` rather
  // than left transparent: react-native-screens gives each stack screen its
  // own native backing, and a transparent one has nothing to stop the outgoing
  // screen from showing through mid-transition — the two cards visibly overlap
  // while sliding. Filling with `color.ground` looks identical at rest (it's
  // the same colour as the shared background) but opaque during the push.
  contentStyle: { backgroundColor: color.ground },
} as const;

/** One screen lives behind the drawer, and every drawer row is a destination on
 *  it (`screens/HomeScreen.tsx`) — Sent and Archive included. Only a message, a
 *  compose or settings is a stack push, so the drawer gesture applies to the
 *  whole of what the drawer can reach. */
function InboxDrawer() {
  return (
    <Drawer.Navigator
      drawerContent={(props) => <CategoryDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        drawerStyle: {
          // The drawer is a bar-coloured surface, not the ground: it holds the
          // account rail and the folder list, both of which lift off black.
          backgroundColor: color.surface,
          borderRightColor: color.line,
          borderRightWidth: 1,
          width: 330,
        },
      }}
    >
      <Drawer.Screen name="Inbox" component={HomeScreen} />
    </Drawer.Navigator>
  );
}

/** The ten-screen UI — the only one. */
function FullStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Home" component={InboxDrawer} options={{ headerShown: false }} />
      {/* Grows out of its inbox row like a single message does, so it needs
          the same four options as `Message` below, for the same reasons. */}
      <Stack.Screen
        name="Conversation"
        component={ConversationScreen}
        options={{
          animation: 'none',
          contentStyle: { backgroundColor: 'transparent' },
          gestureEnabled: false,
          headerShown: false,
          presentation: 'transparentModal',
        }}
      />
      {/* The one screen that is not a push: a message opens by growing out of
          the row that was tapped, which needs the list left visible underneath
          (`transparentModal`), no stack animation of its own, and no native
          back gesture — `ExpandingScreen` holds the pop back until its frame is
          home again, and a half-swiped card cannot be put back on the row.
          The screen draws its own top bar for the same reason: a native header
          would appear at full size before the frame reached it. */}
      <Stack.Screen
        name="Message"
        component={MessageScreen}
        options={{
          animation: 'none',
          contentStyle: { backgroundColor: 'transparent' },
          gestureEnabled: false,
          headerShown: false,
          presentation: 'transparentModal',
        }}
      />
      {/* Draws its own top bar: it holds the account this message leaves as,
          the address under the title, and the send arrow — none of which a
          native header can carry. */}
      <Stack.Screen
        name="Compose"
        component={ComposeScreen}
        options={{ headerShown: false, presentation: 'modal' }}
        initialParams={{}}
      />
      {/* Keys and Recovery draw their own top bar, like Settings and Account —
          a native header is OS chrome that answers to none of the tokens. */}
      <Stack.Screen name="Keys" component={KeysScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Recovery" component={RecoveryScreen} options={{ headerShown: false }} />
      {/* Draws its own top bar, like Settings — it opens with a search field
          and a filter, and a native header above those is one bar too many. */}
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Appearance" component={AppearanceScreen} options={{ headerShown: false }} />
      {/* Settings → Mail → Swipe options. Both are pushes, like Accounts. */}
      <Stack.Screen name="Mail" component={MailScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SwipeOptions" component={SwipeOptionsScreen} options={{ headerShown: false }} />
      {/* Settings → Notifications. A push, drawing its own top bar. */}
      <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ headerShown: false }} />
      {/* Settings → Mail → Labels / Rules → one rule. Pushes, drawing their own
          top bar like the rest of Settings. */}
      <Stack.Screen name="Labels" component={LabelsScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Rules" component={RulesScreen} options={{ headerShown: false }} />
      <Stack.Screen name="RuleEdit" component={RuleEditScreen} options={{ headerShown: false }} />
      <Stack.Screen name="CannedReplies" component={CannedRepliesScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SwipeGlyphDemo" component={SwipeGlyphDemoScreen} options={{ headerShown: false }} />
      {/* Managing a mailbox is a detail screen, not a destination: the drawer
          sets destinations and never pushes, and these two are reached from
          Settings. Both draw their own top bar, like Settings. */}
      <Stack.Screen name="Accounts" component={AccountsScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Account" component={AccountScreen} options={{ headerShown: false }} />
    </Stack.Navigator>
  );
}

function Root() {
  const { booting, session, identity, recovery, addingAccount } = useApp();
  const accent = useAccent();
  // Opened by a signed-in account with no key on this device, and closed by the
  // setup screen itself — not by `identity` becoming non-null, which happens
  // half way through and would unmount the screen before it has asked about
  // publishing.
  const [setupOpen, setSetupOpen] = useState(false);
  const [navReady, setNavReady] = useState(false);
  // A key setup made whose recovery code has not been typed back yet. Read
  // from the store, not the flag above, so closing the app between the key and
  // the drill reopens setup at the drill rather than landing in the inbox.
  const owesDrill = drillOutstanding(recovery, identity?.fingerprint);

  useEffect(() => {
    if (session && (!identity || owesDrill)) setSetupOpen(true);
  }, [identity, owesDrill, session]);

  if (booting) {
    return <View style={{ flex: 1 }} />;
  }

  if (!session) return <ConnectScreen />;
  // `!identity` as well as the flag: the effect above only runs after a render,
  // which left one frame of the previous mailbox's inbox between an added
  // account attaching and its setup screen.
  if (setupOpen || !identity || owesDrill) return <SetupScreen onDone={() => setSetupOpen(false)} />;

  return (
    <DestinationProvider>
      {/* Above the navigator: an open message and the inbox bar it left showing
          are two different screens, and one has to be able to tell the other
          it is still on show. */}
      <ChromeProvider>
        <NavigationContainer onReady={() => setNavReady(true)} ref={navigationRef} theme={navTheme}>
          <FullStack />
        </NavigationContainer>
        <NotificationRouter navigation={navigationRef} ready={navReady} />
      </ChromeProvider>
      {/* Over the navigator rather than instead of it, so a mailbox that
          already has a key lands back where the add was started. First sign-in
          never gets here — the connect screen has its own spinner. */}
      {addingAccount ? (
        <View accessibilityLabel="Adding account" accessibilityRole="progressbar" style={s.adding}>
          <ActivityIndicator color={accent} size="large" />
        </View>
      ) : null}
    </DestinationProvider>
  );
}

const s = StyleSheet.create({
  adding: {
    alignItems: 'center',
    backgroundColor: color.ground,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});

export default function App() {
  // Paint the web page canvas dark so any gutter/overscroll never flashes white.
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.style.backgroundColor = color.ground;
      document.body.style.backgroundColor = color.ground;
    }
  }, []);

  // Gate on the custom faces so text never flashes in a fallback and reflows.
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <AppearanceProvider>
          {/* Sibling of `AppState`'s provider, like appearance's and for the
              same reason: a swipe preference is view state that is persisted,
              not one of the five subsystems. */}
          <MailPrefsProvider>
            {/* Another sibling for the same reason: saved snippets are the
                writer's text on this device, not a subsystem. */}
            <CannedRepliesProvider>
            <AppProvider>
              <AppBackground>
                <ToastProvider>
                  {fontsLoaded ? (
                    <>
                      <Root />
                      <DialogHost />
                    </>
                  ) : (
                    <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
                      <ActivityIndicator color={defaultAccent} />
                    </View>
                  )}
                </ToastProvider>
              </AppBackground>
            </AppProvider>
            </CannedRepliesProvider>
          </MailPrefsProvider>
        </AppearanceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
