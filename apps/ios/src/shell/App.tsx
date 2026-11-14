import { SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.canvas}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.brand}>AgentUI</Text>
          <Text style={styles.subtitle}>Your agents, within reach.</Text>
        </View>
        <View style={styles.panel} testID="disconnected-screen">
          <Text style={styles.status}>Not connected</Text>
          <Text accessibilityRole="header" style={styles.title}>A home for your conversations</Text>
          <Text style={styles.body}>
            AgentUI connects to agents running on your Mac. Your agents and conversations stay on the host.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.label}>This developer build</Text>
          <Text style={styles.body}>
            The iOS app is installed and ready to open. Host pairing and conversations are not available in this build yet.
          </Text>
        </View>
        <Text style={styles.footer}>No host is connected. No credentials are stored.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: '#15171c' },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 32 },
  header: { gap: 8 },
  brand: { color: '#eef0f5', fontSize: 32, fontWeight: '700' },
  subtitle: { color: '#adb6c6', fontSize: 17, lineHeight: 26 },
  panel: {
    backgroundColor: '#1d2027', borderColor: '#3c4350', borderWidth: 1,
    borderRadius: 16, padding: 24, gap: 16,
  },
  status: { color: '#a9b9ff', fontSize: 15, fontWeight: '600' },
  title: { color: '#eef0f5', fontSize: 24, lineHeight: 32, fontWeight: '600' },
  body: { color: '#adb6c6', fontSize: 17, lineHeight: 27 },
  divider: { height: 1, backgroundColor: '#3c4350', marginVertical: 8 },
  label: { color: '#eef0f5', fontSize: 16, fontWeight: '600' },
  footer: { color: '#adb6c6', fontSize: 14, lineHeight: 22 },
});
