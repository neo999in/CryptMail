import { createDrawerNavigator } from '@react-navigation/drawer';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
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
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { InboxDrawerParamList, RootStackParamList } from './src/navigation';
import { ComposeScreen } from './src/screens/ComposeScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { CategoryDrawer } from './src/screens/CategoryDrawer';
import { KeysScreen } from './src/screens/KeysScreen';
import { MessageScreen } from './src/screens/MessageScreen';
import { RecoveryScreen } from './src/screens/RecoveryScreen';
import { AppearanceScreen } from './src/screens/AppearanceScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SetupScreen } from './src/screens/SetupScreen';
import { AppProvider, useApp } from './src/state/AppState';
import { color, defaultAccent, font } from './src/theme';
import { AppBackground } from './src/ui/AppBackground';
import { AppearanceProvider } from './src/ui/appearance';
import { ChromeProvider } from './src/ui/chrome';
import { DialogHost } from './src/ui/dialog';
import { DestinationProvider } from './src/ui/destination';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Drawer = createDrawerNavigator<InboxDrawerParamList>();

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
      <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: 'Conversation' }} />
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
      <Stack.Screen
        name="Compose"
        component={ComposeScreen}
        options={{ title: 'New message', presentation: 'modal' }}
        initialParams={{}}
      />
      <Stack.Screen name="Keys" component={KeysScreen} options={{ title: 'Keys' }} />
      {/* Draws its own top bar, like Settings — it opens with a search field
          and a filter, and a native header above those is one bar too many. */}
      <Stack.Screen name="Recovery" component={RecoveryScreen} options={{ title: 'Key recovery' }} />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Appearance" component={AppearanceScreen} options={{ headerShown: false }} />
    </Stack.Navigator>
  );
}

function Root() {
  const { booting, session, identity } = useApp();
  // Opened by a signed-in account with no key on this device, and closed by the
  // setup screen itself — not by `identity` becoming non-null, which happens
  // half way through and would unmount the screen before it has asked about
  // publishing.
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    if (session && !identity) setSetupOpen(true);
  }, [identity, session]);

  if (booting) {
    return <View style={{ flex: 1 }} />;
  }

  if (!session) return <ConnectScreen />;
  if (setupOpen) return <SetupScreen onDone={() => setSetupOpen(false)} />;

  return (
    <DestinationProvider>
      {/* Above the navigator: an open message and the inbox bar it left showing
          are two different screens, and one has to be able to tell the other
          it is still on show. */}
      <ChromeProvider>
        <NavigationContainer theme={navTheme}>
          <FullStack />
        </NavigationContainer>
      </ChromeProvider>
    </DestinationProvider>
  );
}

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
          <AppProvider>
            <AppBackground>
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
            </AppBackground>
          </AppProvider>
        </AppearanceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
